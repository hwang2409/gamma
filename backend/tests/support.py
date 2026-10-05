"""Test doubles and a real in-process HTTP server for API tests."""

from __future__ import annotations

import asyncio
import contextlib
import socket
from collections.abc import AsyncIterator
from typing import Any

import uvicorn
from fastapi import FastAPI

from gamma.runtime import RuntimeConnection, RuntimeSpec, ZetaRuntime
from gamma.zeta_protocol import Capabilities, EventHandler, HelloResult, ZetaEvent, ZetaRpcError

FAKE_HELLO = HelloResult(
    protocol_version="1.1",
    server="zeta",
    capabilities=Capabilities(
        requests=[
            "list_sessions",
            "new_session",
            "resume",
            "send",
            "steer",
            "approve",
            "deny",
            "abort",
            "status",
        ],
        notifications=["event"],
    ),
)


class FakeConnection(RuntimeConnection):
    """A harness stand-in: records requests and lets a test emit events.

    It keeps the tests that cover fan-out, replay, and the API independent of
    process start-up time; the real harness is covered separately.
    """

    def __init__(self, spec: RuntimeSpec, on_event: EventHandler) -> None:
        self.spec = spec
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.sessions: list[dict[str, Any]] = []
        self.errors: dict[str, ZetaRpcError] = {}
        self._on_event = on_event
        self._alive = True
        self._counter = 0
        self._pending: dict[str, dict[str, Any]] = {}

    @property
    def hello(self) -> HelloResult:
        return FAKE_HELLO

    @property
    def alive(self) -> bool:
        return self._alive

    async def call(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        params = params or {}
        self.calls.append((method, params))
        if method in self.errors:
            raise self.errors[method]
        match method:
            case "new_session":
                self._counter += 1
                return {"session": self._metadata(f"fake-session-{self._counter}", params)}
            case "resume":
                return {"session": self._metadata(params["session_id"], params)}
            case "list_sessions":
                return {"sessions": self.sessions}
            case "send" | "steer":
                return {"accepted": True, "session_id": "fake-session-1"}
            case "abort":
                return {"aborted": True}
            case "approve" | "deny":
                self._pending.pop(params.get("request_id", ""), None)
                return {
                    "accepted": True,
                    "request_id": params.get("request_id"),
                    "decision": "approve" if method == "approve" else "deny",
                }
            case "status":
                return {
                    "session": self._metadata("fake-session-1", params),
                    "state": "idle",
                    "pending_approvals": [
                        {"request_id": request_id, "tool_call": tool_call}
                        for request_id, tool_call in self._pending.items()
                    ],
                    "usage": {},
                    "compaction_markers": 0,
                }
        raise ZetaRpcError(-32601, f"method {method} is not supported")

    def _metadata(self, session_id: str, params: dict[str, Any]) -> dict[str, Any]:
        return {
            "version": 1,
            "session_id": session_id,
            "created_at": "2026-01-01T00:00:00+00:00",
            "updated_at": "2026-01-01T00:00:00+00:00",
            "provider": self.spec.provider,
            "model": params.get("model") or self.spec.model or "offline",
            "cwd": self.spec.cwd or "/tmp",
            "name": "",
            "approval_mode": "ask",
        }

    def emit(self, event: str, **fields: Any) -> None:
        """Push a zeta notification into gamma, as the read loop would."""

        if event == "approval_request":
            self._pending[fields["request_id"]] = fields["tool_call"]
        elif event in ("approval_end", "tool_end"):
            call_id = (fields.get("tool_call") or {}).get("id")
            for request_id, call in list(self._pending.items()):
                if call.get("id") == call_id:
                    self._pending.pop(request_id, None)
        result = self._on_event(ZetaEvent.model_validate({"event": event, **fields}))
        assert result is None, "the session handler must stay synchronous"

    async def aclose(self) -> None:
        self._alive = False


class FakeRuntime(ZetaRuntime):
    def __init__(self) -> None:
        self.launched: list[FakeConnection] = []
        self.sessions: list[dict[str, Any]] = []

    @property
    def last(self) -> FakeConnection:
        return self.launched[-1]

    async def launch(self, spec: RuntimeSpec, on_event: EventHandler) -> RuntimeConnection:
        connection = FakeConnection(spec, on_event)
        connection.sessions = self.sessions
        self.launched.append(connection)
        return connection

    async def aclose(self) -> None:
        for connection in self.launched:
            await connection.aclose()


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


@contextlib.asynccontextmanager
async def serve(app: FastAPI) -> AsyncIterator[str]:
    """Run the app on a real local port, so WebSocket clients can connect."""

    port = free_port()
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
    server = uvicorn.Server(config)
    task = asyncio.create_task(server.serve())
    try:
        for _ in range(200):
            if server.started:
                break
            await asyncio.sleep(0.05)
        if not server.started:
            raise RuntimeError("the test server did not start")
        yield f"127.0.0.1:{port}"
    finally:
        server.should_exit = True
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(task, timeout=10)


__all__ = ["FAKE_HELLO", "FakeConnection", "FakeRuntime", "free_port", "serve"]
