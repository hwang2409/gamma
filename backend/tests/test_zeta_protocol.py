"""Wire models and the JSON-RPC client, against a scripted test server."""

from __future__ import annotations

import asyncio
import json
import shutil
import tempfile
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any

import pytest

from gamma.zeta_protocol import (
    HelloResult,
    Message,
    SessionMetadata,
    StatusResult,
    ToolCall,
    ZetaConnection,
    ZetaEvent,
    ZetaHandshakeError,
    ZetaProtocolError,
    ZetaRpcError,
)

FULL_CAPABILITIES = {
    "requests": [
        "list_sessions",
        "new_session",
        "resume",
        "send",
        "steer",
        "approve",
        "deny",
        "abort",
        "status",
        "slash_list",
    ],
    "notifications": ["event"],
    "features": ["assistant_reset"],
}


# --- model round-trips -----------------------------------------------------


def test_session_metadata_keeps_undocumented_fields() -> None:
    """zeta sends more metadata than its document lists; gamma must not drop it."""

    raw = {
        "version": 1,
        "session_id": "abc123",
        "created_at": "2026-10-05T16:02:16+00:00",
        "updated_at": "2026-10-05T16:02:16+00:00",
        "provider": "codex",
        "model": "gpt-5.6-luna",
        "cwd": "/tmp/work",
        "name": "",
        "approval_mode": "ask",
        "compaction": "evict",
        "tool_deny": [],
    }
    metadata = SessionMetadata.model_validate(raw)
    assert metadata.session_id == "abc123"
    assert metadata.approval_mode == "ask"
    assert metadata.model_dump(mode="json")["compaction"] == "evict"


def test_tool_call_and_message_round_trip() -> None:
    call = ToolCall.model_validate({"id": "tool-1", "name": "read", "arguments": {"path": "a"}})
    assert call.model_dump(mode="json") == {
        "id": "tool-1",
        "name": "read",
        "arguments": {"path": "a"},
    }
    message = Message.model_validate(
        {"role": "assistant", "content": [{"type": "text", "text": "hi"}]}
    )
    assert message.content[0].text == "hi"
    assert message.model_dump(mode="json")["content"][0]["type"] == "text"


def test_status_result_defaults() -> None:
    status = StatusResult.model_validate(
        {"session": None, "state": "idle", "pending_approvals": [], "usage": {}}
    )
    assert status.state == "idle"
    assert status.session is None
    assert status.compaction_markers == 0


def test_event_fields_drop_the_envelope() -> None:
    event = ZetaEvent.model_validate(
        {
            "event": "assistant_delta",
            "session_id": "abc123",
            "delta": "hello",
            "kind": "assistant",
        }
    )
    assert event.event == "assistant_delta"
    assert event.fields == {"delta": "hello", "kind": "assistant"}


def test_hello_result_reports_capabilities() -> None:
    hello = HelloResult.model_validate(
        {"protocol_version": "1.1", "server": "zeta", "capabilities": FULL_CAPABILITIES}
    )
    assert hello.supports("slash_list")
    assert hello.supports_feature("assistant_reset")
    assert not hello.supports("fork_message")


# --- scripted server ------------------------------------------------------

Handler = Callable[[dict[str, Any], asyncio.StreamWriter], Any]


class ScriptedServer:
    """A newline-delimited JSON-RPC server that answers from a handler."""

    def __init__(self, handler: Handler) -> None:
        self._handler = handler
        self.server: asyncio.Server | None = None
        self.path = ""

    async def start(self, path: Path) -> str:
        self.path = str(path)
        self.server = await asyncio.start_unix_server(self._serve, self.path)
        return self.path

    async def stop(self) -> None:
        if self.server is not None:
            self.server.close()
            await self.server.wait_closed()

    async def _serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        while True:
            line = await reader.readline()
            if not line:
                break
            request = json.loads(line)
            response = self._handler(request, writer)
            if asyncio.iscoroutine(response):
                response = await response
            if response is not None:
                writer.write(json.dumps(response).encode() + b"\n")
                await writer.drain()
        writer.close()


@pytest.fixture
async def scripted() -> AsyncIterator[Callable[[Handler], Any]]:
    # Unix socket paths are limited to about 104 bytes on macOS, which the
    # pytest tmp_path layout exceeds; use a short private directory instead.
    directory = Path(tempfile.mkdtemp(prefix="gp-"))
    servers: list[ScriptedServer] = []

    async def make(handler: Handler) -> str:
        server = ScriptedServer(handler)
        servers.append(server)
        return await server.start(directory / f"s{len(servers)}.sock")

    yield make
    for server in servers:
        await server.stop()
    shutil.rmtree(directory, ignore_errors=True)


def _ok(request: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request["id"], "result": result}


async def test_handshake_sends_both_versions_and_accepts_1_1(scripted: Any) -> None:
    seen: list[dict[str, Any]] = []

    def handler(request: dict[str, Any], _writer: asyncio.StreamWriter) -> dict[str, Any]:
        seen.append(request)
        return _ok(
            request,
            {"protocol_version": "1.1", "server": "zeta", "capabilities": FULL_CAPABILITIES},
        )

    path = await scripted(handler)
    connection = await ZetaConnection.connect_unix(path)
    hello = await connection.hello()
    await connection.aclose()

    assert seen[0]["method"] == "hello"
    assert seen[0]["params"] == {
        "protocol_version": "1.0",
        "client_version": "1.1",
        "features": ["assistant_reset", "projects", "list_sessions_paging"],
    }
    assert hello.protocol_version == "1.1"
    assert hello.supports("slash_list")
    assert hello.supports_feature("assistant_reset")


async def test_handshake_accepts_a_1_0_server(scripted: Any) -> None:
    legacy = {
        "requests": [
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
        "notifications": ["event"],
    }

    def handler(request: dict[str, Any], _writer: asyncio.StreamWriter) -> dict[str, Any]:
        return _ok(request, {"protocol_version": "1.0", "server": "zeta", "capabilities": legacy})

    connection = await ZetaConnection.connect_unix(await scripted(handler))
    hello = await connection.hello()
    await connection.aclose()
    assert hello.protocol_version == "1.0"
    assert not hello.supports("slash_list")


async def test_handshake_rejects_an_unknown_protocol_version(scripted: Any) -> None:
    def handler(request: dict[str, Any], _writer: asyncio.StreamWriter) -> dict[str, Any]:
        return _ok(
            request,
            {"protocol_version": "2.0", "server": "zeta", "capabilities": FULL_CAPABILITIES},
        )

    connection = await ZetaConnection.connect_unix(await scripted(handler))
    with pytest.raises(ZetaHandshakeError, match="unsupported zeta protocol version"):
        await connection.hello()
    await connection.aclose()


async def test_handshake_rejects_a_server_without_required_requests(scripted: Any) -> None:
    def handler(request: dict[str, Any], _writer: asyncio.StreamWriter) -> dict[str, Any]:
        return _ok(
            request,
            {
                "protocol_version": "1.1",
                "server": "other",
                "capabilities": {"requests": ["status"], "notifications": ["event"]},
            },
        )

    connection = await ZetaConnection.connect_unix(await scripted(handler))
    with pytest.raises(ZetaHandshakeError, match="lacks required requests"):
        await connection.hello()
    await connection.aclose()


async def test_handshake_mismatch_error_is_surfaced(scripted: Any) -> None:
    def handler(request: dict[str, Any], _writer: asyncio.StreamWriter) -> dict[str, Any]:
        return {
            "jsonrpc": "2.0",
            "id": request["id"],
            "error": {
                "code": -32002,
                "message": "protocol version mismatch",
                "data": {"requested": "1.0", "supported": ["9.9"]},
            },
        }

    connection = await ZetaConnection.connect_unix(await scripted(handler))
    with pytest.raises(ZetaRpcError) as caught:
        await connection.hello()
    await connection.aclose()
    assert caught.value.code == -32002
    assert caught.value.data == {"requested": "1.0", "supported": ["9.9"]}


async def test_assistant_reset_reaches_the_handler(scripted: Any) -> None:
    async def handler(request: dict[str, Any], writer: asyncio.StreamWriter) -> dict[str, Any]:
        if request["method"] == "hello":
            return _ok(
                request,
                {
                    "protocol_version": "1.1",
                    "server": "zeta",
                    "capabilities": FULL_CAPABILITIES,
                },
            )
        writer.write(
            json.dumps(
                {
                    "jsonrpc": "2.0",
                    "method": "event",
                    "params": {
                        "event": "assistant_reset",
                        "session_id": "s1",
                        "data": {},
                    },
                }
            ).encode()
            + b"\n"
        )
        await writer.drain()
        return _ok(request, {"accepted": True, "session_id": "s1"})

    events: list[ZetaEvent] = []
    connection = await ZetaConnection.connect_unix(await scripted(handler), on_event=events.append)
    await connection.hello()
    await connection.call("send", {"text": "hi"})
    await asyncio.sleep(0.05)
    await connection.aclose()

    assert events[0].event == "assistant_reset"
    assert events[0].fields == {"data": {}}


async def test_events_reach_the_handler_while_a_request_is_open(scripted: Any) -> None:
    async def handler(request: dict[str, Any], writer: asyncio.StreamWriter) -> dict[str, Any]:
        if request["method"] == "hello":
            return _ok(
                request,
                {"protocol_version": "1.1", "server": "zeta", "capabilities": FULL_CAPABILITIES},
            )
        for delta in ("he", "llo"):
            writer.write(
                json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "method": "event",
                        "params": {
                            "event": "assistant_delta",
                            "session_id": "s1",
                            "delta": delta,
                            "kind": "assistant",
                        },
                    }
                ).encode()
                + b"\n"
            )
        await writer.drain()
        return _ok(request, {"accepted": True, "session_id": "s1"})

    events: list[ZetaEvent] = []
    connection = await ZetaConnection.connect_unix(await scripted(handler), on_event=events.append)
    await connection.hello()
    result = await connection.call("send", {"text": "hi"})
    await asyncio.sleep(0.05)
    await connection.aclose()

    assert result == {"accepted": True, "session_id": "s1"}
    assert [event.fields["delta"] for event in events] == ["he", "llo"]


async def test_in_flight_request_fails_when_the_server_disappears(scripted: Any) -> None:
    async def handler(
        request: dict[str, Any], writer: asyncio.StreamWriter
    ) -> dict[str, Any] | None:
        if request["method"] == "hello":
            return _ok(
                request,
                {"protocol_version": "1.1", "server": "zeta", "capabilities": FULL_CAPABILITIES},
            )
        writer.close()
        return None

    connection = await ZetaConnection.connect_unix(await scripted(handler))
    await connection.hello()
    with pytest.raises(ZetaProtocolError, match="closed the connection"):
        await connection.call("status", {})
    assert connection.closed
    await connection.aclose()


async def test_call_after_close_is_refused(scripted: Any) -> None:
    def handler(request: dict[str, Any], _writer: asyncio.StreamWriter) -> dict[str, Any]:
        return _ok(
            request,
            {"protocol_version": "1.1", "server": "zeta", "capabilities": FULL_CAPABILITIES},
        )

    connection = await ZetaConnection.connect_unix(await scripted(handler))
    await connection.hello()
    await connection.aclose()
    with pytest.raises(ZetaProtocolError, match="closed"):
        await connection.call("status", {})


# --- transport-error normalization ----------------------------------------
#
# ``StreamWriter.write``/``drain`` can raise a bare ``OSError`` (broken pipe,
# reset), and the read loop can set a raw transport error on a request future.
# ``ZetaConnection.call`` must turn every such mid-request transport death into
# one ``ZetaProtocolError`` so a caller never leaks the OS exception past its
# error handling, while a request timeout and cancellation stay distinct.


class _StubWriter:
    """A writer whose ``write`` or ``drain`` can fail like a dead socket."""

    def __init__(
        self, *, write_error: Exception | None = None, drain_error: Exception | None = None
    ) -> None:
        self._write_error = write_error
        self._drain_error = drain_error

    def write(self, _data: bytes) -> None:
        if self._write_error is not None:
            raise self._write_error

    async def drain(self) -> None:
        if self._drain_error is not None:
            raise self._drain_error

    def close(self) -> None:
        pass

    async def wait_closed(self) -> None:
        pass


class _BlockingReader:
    """A reader that never produces a frame, so the read loop just waits."""

    async def readuntil(self, _separator: bytes) -> bytes:
        await asyncio.Event().wait()
        raise AssertionError("unreachable")


class _ResetReader:
    """A reader that fails like a connection reset on the first read."""

    def __init__(self, error: Exception) -> None:
        self._error = error

    async def readuntil(self, _separator: bytes) -> bytes:
        raise self._error


async def test_write_side_broken_pipe_becomes_a_protocol_error() -> None:
    writer = _StubWriter(write_error=BrokenPipeError("broken pipe"))
    connection = ZetaConnection(_BlockingReader(), writer)  # type: ignore[arg-type]
    with pytest.raises(ZetaProtocolError, match="connection failed"):
        await connection.call("status", {})
    # The transport is dead, so the connection is marked closed and later calls
    # fail fast instead of writing into a broken socket.
    assert connection.closed
    with pytest.raises(ZetaProtocolError, match="closed"):
        await connection.call("status", {})


async def test_drain_side_reset_becomes_a_protocol_error() -> None:
    writer = _StubWriter(drain_error=ConnectionResetError("reset"))
    connection = ZetaConnection(_BlockingReader(), writer)  # type: ignore[arg-type]
    with pytest.raises(ZetaProtocolError, match="connection failed"):
        await connection.call("status", {})
    assert connection.closed


async def test_read_side_reset_mid_request_becomes_a_protocol_error() -> None:
    # The write succeeds, then the read loop hits a raw ``ConnectionResetError``
    # and sets it on the open request's future. ``call`` normalizes it.
    reader = _ResetReader(ConnectionResetError("peer reset"))
    connection = ZetaConnection(reader, _StubWriter())  # type: ignore[arg-type]
    connection.start()
    with pytest.raises(ZetaProtocolError, match="connection failed"):
        await connection.call("status", {})
    assert connection.closed
    await connection.aclose()


async def test_read_side_eof_mid_request_becomes_a_protocol_error() -> None:
    # An incomplete read (EOF mid-frame) is already a protocol error; it must
    # keep its protocol-error type rather than surfacing as a raw EOF.
    reader = _ResetReader(asyncio.IncompleteReadError(partial=b"{", expected=None))
    connection = ZetaConnection(reader, _StubWriter())  # type: ignore[arg-type]
    connection.start()
    with pytest.raises(ZetaProtocolError):
        await connection.call("status", {})
    assert connection.closed
    await connection.aclose()


async def test_cancellation_propagates_and_is_not_normalized() -> None:
    # A caller cancelling an in-flight call must see ``CancelledError``, not a
    # swallowed or normalized transport error.
    connection = ZetaConnection(_BlockingReader(), _StubWriter())  # type: ignore[arg-type]
    task = asyncio.ensure_future(connection.call("status", {}))
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
