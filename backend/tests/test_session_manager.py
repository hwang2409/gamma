"""SessionManager against real scripted ``zeta serve`` harnesses."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

import pytest

from gamma.config import Settings
from gamma.local_runtime import LocalProcessRuntime
from gamma.session import SessionError, SessionManager, SessionNotFound

from .conftest import requires_zeta

pytestmark = requires_zeta


def _is_running(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


async def _wait_for_event(manager_session: object, name: str, timeout: float = 20.0) -> dict:
    bus = manager_session.bus  # type: ignore[attr-defined]
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        for event in bus.replay(0):
            if event.event == name:
                return event.payload
        await asyncio.sleep(0.05)
    raise AssertionError(
        f"event {name!r} never arrived; saw {[event.event for event in bus.replay(0)]}"
    )


@pytest.fixture
async def manager(settings: Settings, local_runtime: LocalProcessRuntime):
    manager = SessionManager(runtime=local_runtime, settings=settings)
    manager.start()
    try:
        yield manager
    finally:
        await manager.aclose()


async def test_create_send_and_derived_state(manager: SessionManager, workspace: Path) -> None:
    session = await manager.create(provider="codex", model="gpt-5.6-luna", cwd=str(workspace))
    assert session.zeta_session_id
    assert session.state == "idle"

    await session.send("hello")
    payload = await _wait_for_event(session, "assistant_message")
    assert payload["message"]["content"][0]["text"] == "you said: hello"
    await _wait_for_event(session, "turn_end")

    assert session.state == "idle"
    assert session.usage.get("output_tokens") == len("you said: hello")
    cursors = [event.cursor for event in session.bus.replay(0)]
    assert cursors == sorted(cursors)

    status = await session.status()
    assert status.state == "idle"
    assert status.session is not None
    assert status.session.cwd == str(workspace.resolve())


async def test_close_reaps_the_harness_process(manager: SessionManager, workspace: Path) -> None:
    session = await manager.create(provider="codex", cwd=str(workspace))
    pid = session._connection.pid  # type: ignore[attr-defined]
    assert _is_running(pid)

    await manager.close(session.session_id)

    assert not _is_running(pid)
    assert manager.list() == []
    with pytest.raises(SessionNotFound):
        manager.get(session.session_id)


async def test_manager_aclose_reaps_every_harness(manager: SessionManager, workspace: Path) -> None:
    first = await manager.create(provider="codex", cwd=str(workspace))
    second = await manager.create(provider="codex", cwd=str(workspace))
    pids = [
        first._connection.pid,  # type: ignore[attr-defined]
        second._connection.pid,  # type: ignore[attr-defined]
    ]

    await manager.aclose()

    assert [pid for pid in pids if _is_running(pid)] == []


async def test_list_zeta_sessions_finds_a_session_made_earlier(
    manager: SessionManager, workspace: Path
) -> None:
    session = await manager.create(provider="codex", cwd=str(workspace))
    await session.send("remember me")
    await _wait_for_event(session, "turn_end")
    created_id = session.zeta_session_id
    await manager.close(session.session_id)

    listed = await manager.list_zeta_sessions("codex")

    assert created_id in [item.session_id for item in listed]
    found = next(item for item in listed if item.session_id == created_id)
    assert found.provider == "codex"
    assert found.cwd == str(workspace.resolve())


async def test_resume_reopens_a_session_in_its_own_directory(
    manager: SessionManager, workspace: Path
) -> None:
    project = workspace / "project"
    first = await manager.create(provider="codex", cwd=str(project))
    await first.send("first turn")
    await _wait_for_event(first, "turn_end")
    zeta_id = first.zeta_session_id
    await manager.close(first.session_id)

    resumed = await manager.create(provider="codex", cwd=str(project), resume_session_id=zeta_id)

    assert resumed.zeta_session_id == zeta_id
    assert resumed.metadata is not None
    assert resumed.metadata.cwd == str(project.resolve())
    await resumed.send("second turn")
    payload = await _wait_for_event(resumed, "assistant_message")
    assert payload["message"]["content"][0]["text"] == "you said: second turn"


async def test_resume_of_an_unknown_session_fails_without_leaking_a_process(
    manager: SessionManager, workspace: Path, local_runtime: LocalProcessRuntime
) -> None:
    with pytest.raises(SessionError):
        await manager.create(
            provider="codex", cwd=str(workspace), resume_session_id="does-not-exist"
        )
    assert manager.list() == []
    assert local_runtime.live_count == 0


async def test_abort_during_a_long_turn(manager: SessionManager, workspace: Path) -> None:
    session = await manager.create(provider="codex", cwd=str(workspace))
    await session.send("x" * 4000)
    await _wait_for_event(session, "turn_start")
    assert session.state == "running"
    result = await session.abort()
    assert result["aborted"] is True

    deadline = asyncio.get_running_loop().time() + 10
    while asyncio.get_running_loop().time() < deadline and session.state != "idle":
        await asyncio.sleep(0.1)
    assert (await session.status()).state == "idle"


async def test_idle_sessions_are_reaped(
    settings: Settings, local_runtime: LocalProcessRuntime, workspace: Path
) -> None:
    quick = settings.model_copy(update={"session_idle_timeout_seconds": 1.0})
    manager = SessionManager(runtime=local_runtime, settings=quick)
    manager.start()
    try:
        session = await manager.create(provider="codex", cwd=str(workspace))
        pid = session._connection.pid  # type: ignore[attr-defined]
        deadline = asyncio.get_running_loop().time() + 15
        while asyncio.get_running_loop().time() < deadline and (manager.list() or _is_running(pid)):
            await asyncio.sleep(0.2)
        assert manager.list() == []
        assert not _is_running(pid)
    finally:
        await manager.aclose()
