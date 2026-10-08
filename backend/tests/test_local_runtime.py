"""LocalProcessRuntime against a real scripted ``zeta serve`` process."""

from __future__ import annotations

import asyncio
import os
import signal
from pathlib import Path

import pytest

from gamma.config import Settings
from gamma.local_runtime import LocalProcessConnection, LocalProcessRuntime
from gamma.runtime import RuntimeLaunchError, RuntimeSpec
from gamma.zeta_protocol import ZetaEvent

from .conftest import requires_zeta

pytestmark = requires_zeta


def _spec(settings: Settings, workspace: Path) -> RuntimeSpec:
    return RuntimeSpec(
        provider="codex",
        model="gpt-5.6-luna",
        cwd=str(workspace),
        env=dict(settings.zeta_env),
    )


def _is_running(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


async def _collect(events: list[ZetaEvent], name: str, timeout: float = 20.0) -> ZetaEvent:
    """Wait for one event by name."""

    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        for event in events:
            if event.event == name:
                return event
        await asyncio.sleep(0.05)
    raise AssertionError(f"event {name!r} never arrived; saw {[e.event for e in events]}")


async def test_launch_handshake_send_and_shutdown(
    local_runtime: LocalProcessRuntime, settings: Settings, workspace: Path
) -> None:
    events: list[ZetaEvent] = []
    connection = await local_runtime.launch(_spec(settings, workspace), events.append)
    assert isinstance(connection, LocalProcessConnection)

    # The handshake gates on the version the server returned.
    assert connection.hello.protocol_version in ("1.0", "1.1")
    assert connection.hello.supports("send")
    assert connection.alive

    created = await connection.call("new_session", {"provider": "codex", "model": "gpt-5.6-luna"})
    session_id = created["session"]["session_id"]
    assert created["session"]["cwd"] == str(workspace.resolve())

    accepted = await connection.call("send", {"text": "hello"})
    assert accepted == {"accepted": True, "session_id": session_id}

    message = await _collect(events, "assistant_message")
    assert message.fields["message"]["content"][0]["text"] == "you said: hello"
    names = [event.event for event in events]
    assert "turn_start" in names
    assert "assistant_delta" in names
    assert "turn_end" in names

    status = await connection.call("status", {})
    assert status["state"] == "idle"

    pid = connection.pid
    assert _is_running(pid)
    await connection.aclose()
    assert not connection.alive
    assert not _is_running(pid)
    assert local_runtime.live_count == 0


async def test_abort_stops_a_running_turn(
    local_runtime: LocalProcessRuntime, settings: Settings, workspace: Path
) -> None:
    events: list[ZetaEvent] = []
    connection = await local_runtime.launch(_spec(settings, workspace), events.append)
    await connection.call("new_session", {"provider": "codex", "model": "gpt-5.6-luna"})
    # The scripted backend pauses before its reply, so abort immediately after
    # the accepted send while the turn is still running.
    await connection.call("send", {"text": "x" * 4000})
    aborted = await connection.call("abort", {})
    assert aborted["aborted"] is True

    deadline = asyncio.get_running_loop().time() + 10
    while asyncio.get_running_loop().time() < deadline:
        if (await connection.call("status", {}))["state"] == "idle":
            break
        await asyncio.sleep(0.1)
    assert (await connection.call("status", {}))["state"] == "idle"
    await connection.aclose()


async def test_runtime_aclose_reaps_every_child(
    local_runtime: LocalProcessRuntime, settings: Settings, workspace: Path
) -> None:
    first = await local_runtime.launch(_spec(settings, workspace), lambda event: None)
    second = await local_runtime.launch(_spec(settings, workspace), lambda event: None)
    pids = [first.pid, second.pid]  # type: ignore[attr-defined]
    assert local_runtime.live_count == 2

    await local_runtime.aclose()

    assert local_runtime.live_count == 0
    assert [pid for pid in pids if _is_running(pid)] == []


async def test_each_session_gets_its_own_process(
    local_runtime: LocalProcessRuntime, settings: Settings, workspace: Path
) -> None:
    """zeta serve takes one client, so two gamma sessions need two processes."""

    first = await local_runtime.launch(_spec(settings, workspace), lambda event: None)
    second = await local_runtime.launch(_spec(settings, workspace), lambda event: None)
    assert first.pid != second.pid  # type: ignore[attr-defined]

    one = await first.call("new_session", {"provider": "codex"})
    two = await second.call("new_session", {"provider": "codex"})
    assert one["session"]["session_id"] != two["session"]["session_id"]
    await first.aclose()
    await second.aclose()


async def test_launch_fails_loudly_for_a_missing_binary(workspace: Path) -> None:
    runtime = LocalProcessRuntime(zeta_bin="zeta-does-not-exist")
    with pytest.raises(RuntimeLaunchError, match="cannot start"):
        await runtime.launch(RuntimeSpec(provider="codex", cwd=str(workspace)), lambda event: None)
    await runtime.aclose()


async def test_launch_fails_when_the_binary_never_listens(workspace: Path) -> None:
    runtime = LocalProcessRuntime(zeta_bin="/usr/bin/true", socket_wait_seconds=5)
    with pytest.raises(RuntimeLaunchError, match="before listening"):
        await runtime.launch(RuntimeSpec(provider="codex", cwd=str(workspace)), lambda event: None)
    await runtime.aclose()


async def test_close_kills_a_child_that_ignores_sigterm(
    local_runtime: LocalProcessRuntime, settings: Settings, workspace: Path
) -> None:
    connection = await local_runtime.launch(_spec(settings, workspace), lambda event: None)
    pid = connection.pid  # type: ignore[attr-defined]
    os.kill(pid, signal.SIGSTOP)  # a stopped child cannot handle SIGTERM
    try:
        await asyncio.wait_for(connection.aclose(), timeout=20)
    finally:
        if _is_running(pid):
            os.kill(pid, signal.SIGKILL)
    assert not _is_running(pid)
