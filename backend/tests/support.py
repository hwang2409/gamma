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


def _hello_with_projects(*, session_paging: bool = True) -> HelloResult:
    """A handshake that advertises the optional ``projects`` feature.

    ``session_paging`` also advertises ``list_sessions_paging`` so a test can
    exercise both a paging server and one that can only return a prefix.
    """

    data = FAKE_HELLO.model_dump()
    features = ["assistant_reset", "projects"]
    if session_paging:
        features.append("list_sessions_paging")
    data["capabilities"]["features"] = features
    return HelloResult.model_validate(data)


class ProjectsFixture:
    """In-memory project data a :class:`FakeConnection` serves.

    It answers the four read-only project requests and the ``project_id``
    filter on ``list_sessions`` straight from Python data, so the API tests do
    not need a real harness. An unknown project id raises the same structured
    ``project_not_found`` error the real server sends.
    """

    def __init__(
        self,
        *,
        projects: list[dict[str, Any]] | None = None,
        details: dict[str, dict[str, Any]] | None = None,
        memory_log: dict[str, list[dict[str, Any]]] | None = None,
        memory_versions: dict[tuple[str, str, str], dict[str, Any]] | None = None,
        inbox: dict[tuple[str, str], dict[str, Any]] | None = None,
        sessions: list[dict[str, Any]] | None = None,
        session_paging: bool = True,
        session_page_size: int | None = None,
    ) -> None:
        self.projects = projects or []
        self.details = details or {}
        self.memory_log = memory_log or {}
        self.memory_versions = memory_versions or {}
        self.inbox = inbox or {}
        self.sessions = sessions or []
        # Whether the fake server advertises ``list_sessions_paging`` and, when
        # it does, how many sessions each page holds (``None`` means one page).
        self.session_paging = session_paging
        self.session_page_size = session_page_size

    def _require(self, project_id: object) -> str:
        if not isinstance(project_id, str) or not project_id:
            raise ZetaRpcError(-32602, "project_id must be a non-empty string")
        known = {item["id"] for item in self.projects} | set(self.details)
        if project_id not in known:
            raise ZetaRpcError(
                -32602,
                "project not found",
                {"code": "project_not_found", "project_id": project_id},
            )
        return project_id

    def answer(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        if method == "list_projects":
            return self._list_projects(params)
        project_id = self._require(params.get("project_id"))
        if method == "project_show":
            return self.details[project_id]
        if method == "project_memory_log":
            return self._memory(project_id, params)
        if method == "project_inbox":
            return self._inbox(project_id, params)
        if method == "list_sessions":
            return self._sessions(project_id, params)
        raise ZetaRpcError(-32601, f"method {method} is not supported")

    def _list_projects(self, params: dict[str, Any]) -> dict[str, Any]:
        offset = int(params.get("offset", 0))
        limit = params.get("limit")
        page = self.projects[offset:]
        if limit is not None:
            page = page[: int(limit)]
        end = offset + len(page)
        return {"projects": page, "next_offset": end if end < len(self.projects) else None}

    def _memory(self, project_id: str, params: dict[str, Any]) -> dict[str, Any]:
        if "version_id" in params or "file" in params:
            key = (project_id, str(params.get("version_id")), str(params.get("file")))
            if key not in self.memory_versions:
                raise ZetaRpcError(-32602, "unknown version or file")
            return {"version": self.memory_versions[key]}
        versions = self.memory_log.get(project_id, [])
        offset = int(params.get("offset", 0))
        limit = params.get("limit")
        page = versions[offset:]
        if limit is not None:
            page = page[: int(limit)]
        end = offset + len(page)
        return {"versions": page, "next_offset": end if end < len(versions) else None}

    def _inbox(self, project_id: str, params: dict[str, Any]) -> dict[str, Any]:
        status = str(params.get("status", "new"))
        stored = self.inbox.get((project_id, status))
        messages = list(stored.get("messages", [])) if stored else []
        offset = int(params.get("offset", 0))
        limit = params.get("limit")
        page = messages[offset:]
        if limit is not None:
            page = page[: int(limit)]
        end = offset + len(page)
        untrusted = any(item.get("origin", "local") != "local" for item in page)
        return {
            "status": status,
            "messages": page,
            "untrusted": untrusted,
            "next_offset": end if end < len(messages) else None,
        }

    def _sessions(self, project_id: str, params: dict[str, Any]) -> dict[str, Any]:
        linked = [item for item in self.sessions if item.get("project_id") == project_id]
        if not self.session_paging:
            # No paging feature: return the largest fitting prefix. A frame bound
            # (modelled by ``session_page_size``) cuts the page and marks it
            # truncated; the client cannot request the rest.
            size = self.session_page_size
            if size is not None and len(linked) > size:
                return {"sessions": linked[:size], "truncated": True, "next_offset": size}
            return {"sessions": linked, "truncated": False, "next_offset": None}
        if "offset" in params and not isinstance(params["offset"], int):
            raise ZetaRpcError(-32602, "offset must be an integer")
        offset = int(params.get("offset", 0))
        page = linked[offset:]
        size = self.session_page_size
        if size is not None:
            page = page[:size]
        elif params.get("limit") is not None:
            page = page[: int(params["limit"])]
        end = offset + len(page)
        return {"sessions": page, "next_offset": end if end < len(linked) else None}


class FakeConnection(RuntimeConnection):
    """A harness stand-in: records requests and lets a test emit events.

    It keeps the tests that cover fan-out, replay, and the API independent of
    process start-up time; the real harness is covered separately.
    """

    def __init__(
        self,
        spec: RuntimeSpec,
        on_event: EventHandler,
        *,
        projects: ProjectsFixture | None = None,
    ) -> None:
        self.spec = spec
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.sessions: list[dict[str, Any]] = []
        self.errors: dict[str, ZetaRpcError] = {}
        self.projects = projects
        self._on_event = on_event
        self._alive = True
        self._counter = 0
        self._pending: dict[str, dict[str, Any]] = {}

    @property
    def hello(self) -> HelloResult:
        if self.projects is None:
            return FAKE_HELLO
        return _hello_with_projects(session_paging=self.projects.session_paging)

    @property
    def alive(self) -> bool:
        return self._alive

    async def call(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        params = params or {}
        self.calls.append((method, params))
        if method in self.errors:
            raise self.errors[method]
        if self.projects is not None and (
            method in ("list_projects", "project_show", "project_memory_log", "project_inbox")
            or (method == "list_sessions" and "project_id" in params)
        ):
            return self.projects.answer(method, params)
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
    def __init__(self, *, projects: ProjectsFixture | None = None) -> None:
        self.launched: list[FakeConnection] = []
        self.sessions: list[dict[str, Any]] = []
        self.projects = projects
        # Errors applied to every connection this runtime launches, so a test
        # can make a short-lived project connection fail a specific request.
        self.errors: dict[str, ZetaRpcError] = {}

    @property
    def last(self) -> FakeConnection:
        return self.launched[-1]

    async def launch(self, spec: RuntimeSpec, on_event: EventHandler) -> RuntimeConnection:
        connection = FakeConnection(spec, on_event, projects=self.projects)
        connection.sessions = self.sessions
        connection.errors.update(self.errors)
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


__all__ = [
    "FAKE_HELLO",
    "FakeConnection",
    "FakeRuntime",
    "ProjectsFixture",
    "free_port",
    "serve",
]
