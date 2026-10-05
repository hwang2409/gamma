"""The session WebSocket: auth, fan-out to several tabs, replay, commands."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
import websockets
from websockets.exceptions import ConnectionClosed

from gamma.app import create_app
from gamma.config import Settings
from gamma.security import TOKEN_HEADER

from .support import FakeRuntime, serve

GOOD_ORIGIN = "http://localhost:5173"
TOKEN = "test-token"


class Harness:
    """A running gamma server plus helpers to drive it."""

    def __init__(self, address: str, runtime: FakeRuntime) -> None:
        self.address = address
        self.runtime = runtime

    def url(self, path: str) -> str:
        return f"http://{self.address}{path}"

    def ws_url(self, session_id: str, *, cursor: int = 0, token: str | None = TOKEN) -> str:
        query = f"?cursor={cursor}" + (f"&token={token}" if token is not None else "")
        return f"ws://{self.address}/api/sessions/{session_id}/ws{query}"

    async def create_session(self) -> str:
        async with httpx.AsyncClient(headers={TOKEN_HEADER: TOKEN}) as client:
            response = await client.post(self.url("/api/sessions"), json={"provider": "fake"})
        response.raise_for_status()
        return str(response.json()["session_id"])

    async def connect(
        self,
        session_id: str,
        *,
        cursor: int = 0,
        token: str | None = TOKEN,
        origin: str = GOOD_ORIGIN,
    ) -> Any:
        return await websockets.connect(
            self.ws_url(session_id, cursor=cursor, token=token), origin=origin
        )


@pytest.fixture
async def harness(settings: Settings) -> AsyncIterator[Harness]:
    runtime = FakeRuntime()
    app = create_app(settings=settings, runtime=runtime)
    async with serve(app) as address:
        yield Harness(address, runtime)


async def recv_json(socket: Any, timeout: float = 5.0) -> dict[str, Any]:
    raw = await asyncio.wait_for(socket.recv(), timeout=timeout)
    return dict(json.loads(raw))


async def recv_until(socket: Any, frame_type: str, timeout: float = 5.0) -> dict[str, Any]:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        frame = await recv_json(socket, timeout=timeout)
        if frame["type"] == frame_type:
            return frame
    raise AssertionError(f"no {frame_type} frame arrived")


# --- auth ------------------------------------------------------------------


async def test_ws_rejects_a_foreign_origin(harness: Harness) -> None:
    session_id = await harness.create_session()
    with pytest.raises(websockets.exceptions.InvalidStatus) as caught:
        await harness.connect(session_id, origin="http://evil.example")
    assert caught.value.response.status_code == 403


async def test_ws_rejects_a_missing_origin(harness: Harness) -> None:
    session_id = await harness.create_session()
    with pytest.raises(websockets.exceptions.InvalidStatus):
        await websockets.connect(harness.ws_url(session_id))


async def test_ws_without_a_token_is_closed(harness: Harness) -> None:
    session_id = await harness.create_session()
    socket = await harness.connect(session_id, token=None)
    await socket.send(json.dumps({"type": "send", "text": "hi"}))
    with pytest.raises(ConnectionClosed) as caught:
        await recv_json(socket)
    assert caught.value.rcvd.code == 4401


async def test_ws_with_a_wrong_token_is_closed(harness: Harness) -> None:
    session_id = await harness.create_session()
    socket = await harness.connect(session_id, token="nope")
    with pytest.raises(ConnectionClosed) as caught:
        await recv_json(socket)
    assert caught.value.rcvd.code == 4403


async def test_ws_accepts_the_token_in_the_first_message(harness: Harness) -> None:
    session_id = await harness.create_session()
    socket = await harness.connect(session_id, token=None)
    await socket.send(json.dumps({"type": "auth", "token": TOKEN}))
    frame = await recv_json(socket)
    assert frame["type"] == "snapshot"
    await socket.close()


async def test_ws_for_an_unknown_session_is_closed(harness: Harness) -> None:
    socket = await harness.connect("no-such-session")
    with pytest.raises(ConnectionClosed) as caught:
        await recv_json(socket)
    assert caught.value.rcvd.code == 4404


# --- snapshot and fan-out --------------------------------------------------


async def test_snapshot_describes_the_session(harness: Harness) -> None:
    session_id = await harness.create_session()
    socket = await harness.connect(session_id)
    frame = await recv_json(socket)
    assert frame["type"] == "snapshot"
    assert frame["session"]["session_id"] == session_id
    assert frame["session"]["zeta_session_id"] == "fake-session-1"
    assert frame["session"]["state"] == "idle"
    assert frame["replay_from"] == 0
    await socket.close()


async def test_two_clients_see_the_same_events(harness: Harness) -> None:
    session_id = await harness.create_session()
    first = await harness.connect(session_id)
    second = await harness.connect(session_id)
    await recv_until(first, "snapshot")
    await recv_until(second, "snapshot")

    connection = harness.runtime.last
    connection.emit("turn_start", data={"turn": 1})
    connection.emit("assistant_delta", delta="hel", kind="assistant")
    connection.emit("assistant_delta", delta="lo", kind="assistant")
    connection.emit("turn_end", data={"turn": 1, "tool_calls": 0})

    async def drain(socket: Any) -> list[tuple[int, str]]:
        collected: list[tuple[int, str]] = []
        while len(collected) < 5:
            frame = await recv_json(socket)
            if frame["type"] == "event":
                collected.append((frame["cursor"], frame["event"]))
        return collected

    one, two = await asyncio.gather(drain(first), drain(second))
    assert one == two
    assert [event for _, event in one] == [
        "gamma_session_ready",
        "turn_start",
        "assistant_delta",
        "assistant_delta",
        "turn_end",
    ]
    assert [cursor for cursor, _ in one] == [1, 2, 3, 4, 5]
    await first.close()
    await second.close()


async def test_a_reconnecting_client_replays_from_its_cursor(harness: Harness) -> None:
    session_id = await harness.create_session()
    socket = await harness.connect(session_id)
    await recv_until(socket, "snapshot")
    connection = harness.runtime.last
    connection.emit("turn_start", data={"turn": 1})
    connection.emit("assistant_delta", delta="one", kind="assistant")
    seen = [(await recv_until(socket, "event"))["cursor"] for _ in range(3)]
    await socket.close()

    # Events keep arriving while the tab is away.
    connection.emit("assistant_delta", delta="two", kind="assistant")
    connection.emit("turn_end", data={"turn": 1})

    again = await harness.connect(session_id, cursor=seen[-1])
    snapshot = await recv_until(again, "snapshot")
    assert snapshot["replay_from"] == seen[-1]
    replayed = [(await recv_until(again, "event")) for _ in range(2)]
    assert [frame["cursor"] for frame in replayed] == [4, 5]
    assert replayed[0]["payload"]["delta"] == "two"
    await again.close()


async def test_a_late_client_replays_the_whole_buffer(harness: Harness) -> None:
    session_id = await harness.create_session()
    connection = harness.runtime.last
    connection.emit("turn_start", data={"turn": 1})
    connection.emit("assistant_message", message={"role": "assistant", "content": []})

    socket = await harness.connect(session_id)
    await recv_until(socket, "snapshot")
    events = [(await recv_until(socket, "event"))["event"] for _ in range(3)]
    assert events == ["gamma_session_ready", "turn_start", "assistant_message"]
    await socket.close()


async def test_closing_a_session_closes_its_sockets(harness: Harness) -> None:
    session_id = await harness.create_session()
    socket = await harness.connect(session_id)
    await recv_until(socket, "snapshot")
    async with httpx.AsyncClient(headers={TOKEN_HEADER: TOKEN}) as client:
        await client.delete(harness.url(f"/api/sessions/{session_id}"))
    with pytest.raises(ConnectionClosed):
        for _ in range(10):
            await recv_json(socket)


# --- commands --------------------------------------------------------------


async def test_send_steer_abort_reach_the_harness(harness: Harness) -> None:
    session_id = await harness.create_session()
    socket = await harness.connect(session_id)
    await recv_until(socket, "snapshot")
    connection = harness.runtime.last
    seen: list[dict[str, Any]] = []

    async def collect(count: int) -> None:
        while len(seen) < count:
            seen.append(await recv_json(socket))

    await socket.send(json.dumps({"type": "send", "text": "hello"}))
    await socket.send(json.dumps({"type": "steer", "text": "also tests"}))
    await socket.send(json.dumps({"type": "abort"}))
    # one ready event, three acks, and two echoed user messages
    await collect(6)

    acks = [frame for frame in seen if frame["type"] == "ack"]
    assert [frame["command"] for frame in acks] == ["send", "steer", "abort"]
    assert acks[0]["result"]["accepted"] is True
    assert acks[2]["result"] == {"aborted": True}

    echoes = [frame["payload"] for frame in seen if frame.get("event") == "gamma_user_message"]
    assert echoes == [
        {"text": "hello", "mode": "send"},
        {"text": "also tests", "mode": "steer"},
    ]
    assert ("send", {"text": "hello"}) in connection.calls
    assert ("steer", {"text": "also tests"}) in connection.calls
    assert ("abort", {}) in connection.calls
    await socket.close()


async def test_approval_flows_through_and_clears_the_pending_entry(
    harness: Harness,
) -> None:
    session_id = await harness.create_session()
    socket = await harness.connect(session_id)
    await recv_until(socket, "snapshot")
    connection = harness.runtime.last
    connection.emit(
        "approval_request",
        request_id="tool-call-1",
        tool_call={"id": "tool-call-1", "name": "bash", "arguments": {"command": "ls"}},
    )
    event = await recv_until(socket, "event")
    while event["event"] != "approval_request":
        event = await recv_until(socket, "event")
    assert event["payload"]["tool_call"]["name"] == "bash"

    async with httpx.AsyncClient(headers={TOKEN_HEADER: TOKEN}) as client:
        pending = (await client.get(harness.url(f"/api/sessions/{session_id}"))).json()
    assert [item["request_id"] for item in pending["pending_approvals"]] == ["tool-call-1"]

    await socket.send(
        json.dumps({"type": "approve", "request_id": "tool-call-1", "scope": "always_tool"})
    )
    ack = await recv_until(socket, "ack")
    assert ack["command"] == "approve"
    assert (
        "approve",
        {"request_id": "tool-call-1", "scope": "always_tool"},
    ) in connection.calls
    decision = await recv_until(socket, "event")
    while decision["event"] != "gamma_approval_decision":
        decision = await recv_until(socket, "event")
    assert decision["payload"] == {
        "request_id": "tool-call-1",
        "decision": "approve",
        "scope": "always_tool",
    }
    await socket.close()


async def test_a_once_decision_omits_the_scope_key(harness: Harness) -> None:
    """A 1.0 server ignores an unknown key, so gamma sends it only when needed."""

    session_id = await harness.create_session()
    socket = await harness.connect(session_id)
    await recv_until(socket, "snapshot")
    await socket.send(json.dumps({"type": "deny", "request_id": "tool-call-1"}))
    await recv_until(socket, "ack")
    assert ("deny", {"request_id": "tool-call-1"}) in harness.runtime.last.calls
    await socket.close()


async def test_a_zeta_error_becomes_an_error_frame(harness: Harness) -> None:
    from gamma.zeta_protocol import ZetaRpcError

    session_id = await harness.create_session()
    socket = await harness.connect(session_id)
    await recv_until(socket, "snapshot")
    harness.runtime.last.errors["steer"] = ZetaRpcError(-32005, "no turn is running")

    await socket.send(json.dumps({"type": "steer", "text": "late"}))
    frame = await recv_until(socket, "error")
    assert frame["message"] == "no turn is running"
    assert frame["command"] == "steer"
    await socket.close()


async def test_an_invalid_command_is_reported_and_the_socket_stays_open(
    harness: Harness,
) -> None:
    session_id = await harness.create_session()
    socket = await harness.connect(session_id)
    await recv_until(socket, "snapshot")

    await socket.send(json.dumps({"type": "send"}))
    assert "text" in (await recv_until(socket, "error"))["message"]

    await socket.send("not json at all")
    assert (await recv_until(socket, "error"))["type"] == "error"

    await socket.send(json.dumps({"type": "ping"}))
    assert (await recv_until(socket, "pong"))["type"] == "pong"
    await socket.close()


# --- derived state seen by a late tab ----------------------------------------


async def test_a_snapshot_between_model_turns_is_still_running(harness: Harness) -> None:
    """zeta ends each model turn with `turn_end`; only `agent_end` ends the run."""

    session_id = await harness.create_session()
    connection = harness.runtime.last
    connection.emit("agent_start", data={})
    connection.emit("turn_start", data={"turn": 1})
    connection.emit("turn_end", data={"turn": 1, "tool_calls": 1})

    socket = await harness.connect(session_id)
    assert (await recv_until(socket, "snapshot"))["session"]["state"] == "running"
    await socket.close()

    connection.emit("agent_end", data={})
    late = await harness.connect(session_id)
    assert (await recv_until(late, "snapshot"))["session"]["state"] == "idle"
    await late.close()


async def test_a_snapshot_keeps_the_approval_details_zeta_resolved(harness: Harness) -> None:
    session_id = await harness.create_session()
    connection = harness.runtime.last
    display = {"effective_cwd": "/work/acme", "resolved_path": "/work/acme/src/app.py"}
    connection.emit("agent_start", data={})
    connection.emit(
        "approval_request",
        request_id="r1",
        tool_call={"id": "c1", "name": "edit", "arguments": {"path": "src/app.py"}},
        delegated=False,
        approval_display=display,
    )

    socket = await harness.connect(session_id)
    snapshot = await recv_until(socket, "snapshot")
    [pending] = snapshot["session"]["pending_approvals"]
    assert pending["request_id"] == "r1"
    assert pending["approval_display"]["effective_cwd"] == "/work/acme"
    assert pending["approval_display"]["resolved_path"] == "/work/acme/src/app.py"
    replayed = await recv_until(socket, "event")
    while replayed["event"] != "approval_request":
        replayed = await recv_until(socket, "event")
    assert replayed["payload"]["approval_display"] == display
    await socket.close()


async def test_a_session_is_labelled_by_its_first_prompt(harness: Harness) -> None:
    session_id = await harness.create_session()
    socket = await harness.connect(session_id)
    await recv_until(socket, "snapshot")
    await socket.send(json.dumps({"type": "send", "text": "Fix the\n  health check"}))
    await recv_until(socket, "ack")
    await socket.send(json.dumps({"type": "send", "text": "and then the docs"}))
    await recv_until(socket, "ack")
    await socket.close()

    async with httpx.AsyncClient(headers={TOKEN_HEADER: TOKEN}) as client:
        listed = (await client.get(harness.url("/api/sessions"))).json()["sessions"]
    assert [item["first_prompt"] for item in listed] == ["Fix the health check"]
