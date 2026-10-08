"""REST behavior: the token gate, the Origin gate, and launch policy."""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest

from gamma.app import create_app
from gamma.config import Settings
from gamma.security import TOKEN_HEADER

from .support import FakeRuntime

GOOD_ORIGIN = "http://localhost:5173"


@pytest.fixture
def fake_runtime() -> FakeRuntime:
    return FakeRuntime()


@pytest.fixture
async def client(settings: Settings, fake_runtime: FakeRuntime) -> AsyncIterator[httpx.AsyncClient]:
    app = create_app(settings=settings, runtime=fake_runtime)
    transport = httpx.ASGITransport(app=app)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://gamma.test",
            headers={TOKEN_HEADER: "test-token"},
        ) as http_client:
            yield http_client


# --- auth ------------------------------------------------------------------


async def test_health_needs_no_token(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/health", headers={TOKEN_HEADER: ""})
    assert response.status_code == 200


async def test_rest_without_a_token_is_401(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/sessions", headers={TOKEN_HEADER: ""})
    assert response.status_code == 401
    assert "token" in response.json()["detail"]


async def test_rest_with_a_wrong_token_is_403(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/sessions", headers={TOKEN_HEADER: "nope"})
    assert response.status_code == 403


async def test_rest_accepts_the_token_in_a_cookie(
    settings: Settings, fake_runtime: FakeRuntime
) -> None:
    app = create_app(settings=settings, runtime=fake_runtime)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://gamma.test",
        cookies={"gamma_token": "test-token"},
    ) as cookie_client:
        response = await cookie_client.get("/api/sessions", headers={"origin": GOOD_ORIGIN})
    assert response.status_code == 200


async def test_rest_rejects_a_foreign_origin(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/sessions", headers={"origin": "http://evil.example"})
    assert response.status_code == 403
    assert "origin" in response.json()["detail"]


async def test_a_token_never_appears_in_a_response(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/options")
    assert "test-token" not in response.text


# --- options ---------------------------------------------------------------


async def test_options_lists_only_allowed_providers_and_roots(
    client: httpx.AsyncClient, workspace: Path
) -> None:
    body = (await client.get("/api/options")).json()
    assert [provider["name"] for provider in body["providers"]] == ["codex"]
    assert body["providers"][0]["models"] == ["gpt-5.6-luna", "gpt-5.6-sol"]
    assert body["allowed_roots"] == [str(workspace)]
    assert str(workspace / "project") in body["directories"]
    assert body["approval_mode"] == "ask"


# --- launch policy ---------------------------------------------------------


async def test_create_session_defaults_to_the_first_model_and_root(
    client: httpx.AsyncClient, workspace: Path, fake_runtime: FakeRuntime
) -> None:
    response = await client.post("/api/sessions", json={"provider": "codex"})
    assert response.status_code == 201
    body = response.json()
    assert body["provider"] == "codex"
    assert body["model"] == "gpt-5.6-luna"
    assert body["cwd"] == str(workspace)
    assert body["zeta_session_id"] == "fake-session-1"
    assert body["state"] == "idle"
    assert fake_runtime.last.spec.cwd == str(workspace)


async def test_create_session_rejects_a_provider_outside_the_allowlist(
    client: httpx.AsyncClient,
) -> None:
    response = await client.post("/api/sessions", json={"provider": "claude"})
    assert response.status_code == 400
    assert "provider" in response.json()["detail"]


async def test_create_session_rejects_a_model_outside_the_allowlist(
    client: httpx.AsyncClient,
) -> None:
    response = await client.post(
        "/api/sessions", json={"provider": "codex", "model": "claude-opus-4-6"}
    )
    assert response.status_code == 400
    assert "model" in response.json()["detail"]


async def test_create_session_rejects_a_cwd_outside_the_allowed_root(
    client: httpx.AsyncClient,
) -> None:
    response = await client.post("/api/sessions", json={"provider": "codex", "cwd": "/etc"})
    assert response.status_code == 400
    assert "outside the allowed roots" in response.json()["detail"]


async def test_create_session_rejects_a_cwd_that_is_not_a_directory(
    client: httpx.AsyncClient, workspace: Path
) -> None:
    missing = workspace / "nope"
    response = await client.post("/api/sessions", json={"provider": "codex", "cwd": str(missing)})
    assert response.status_code == 400
    assert "existing directory" in response.json()["detail"]


async def test_create_session_rejects_a_symlink_that_escapes_the_root(
    client: httpx.AsyncClient, workspace: Path
) -> None:
    escape = workspace / "escape"
    escape.symlink_to("/etc")
    response = await client.post("/api/sessions", json={"provider": "codex", "cwd": str(escape)})
    assert response.status_code == 400
    assert "outside the allowed roots" in response.json()["detail"]


async def test_create_session_rejects_a_relative_cwd(client: httpx.AsyncClient) -> None:
    response = await client.post("/api/sessions", json={"provider": "codex", "cwd": "project"})
    assert response.status_code == 400
    assert "absolute" in response.json()["detail"]


async def test_create_session_rejects_unknown_body_fields(
    client: httpx.AsyncClient,
) -> None:
    response = await client.post("/api/sessions", json={"provider": "codex", "tools": "bash"})
    assert response.status_code == 422


async def test_session_limit_is_enforced(settings: Settings, fake_runtime: FakeRuntime) -> None:
    app = create_app(settings=settings.model_copy(update={"max_sessions": 1}), runtime=fake_runtime)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://gamma.test",
            headers={TOKEN_HEADER: "test-token"},
        ) as client:
            first = await client.post("/api/sessions", json={"provider": "codex"})
            assert first.status_code == 201
            second = await client.post("/api/sessions", json={"provider": "codex"})
            assert second.status_code == 409
            assert "too many open sessions" in second.json()["detail"]


# --- registry --------------------------------------------------------------


async def test_list_create_status_and_close(client: httpx.AsyncClient) -> None:
    created = (await client.post("/api/sessions", json={"provider": "codex"})).json()
    session_id = created["session_id"]

    listed = (await client.get("/api/sessions")).json()["sessions"]
    assert [item["session_id"] for item in listed] == [session_id]

    status = (await client.get(f"/api/sessions/{session_id}")).json()
    assert status["state"] == "idle"
    assert status["protocol_version"] == "1.1"

    assert (await client.delete(f"/api/sessions/{session_id}")).status_code == 204
    assert (await client.get("/api/sessions")).json()["sessions"] == []
    assert (await client.get(f"/api/sessions/{session_id}")).status_code == 404
    assert (await client.delete(f"/api/sessions/{session_id}")).status_code == 404


async def test_closing_a_session_closes_its_harness(
    client: httpx.AsyncClient, fake_runtime: FakeRuntime
) -> None:
    created = (await client.post("/api/sessions", json={"provider": "codex"})).json()
    connection = fake_runtime.last
    assert connection.alive
    await client.delete(f"/api/sessions/{created['session_id']}")
    assert not connection.alive


async def test_app_shutdown_closes_every_harness(
    settings: Settings, fake_runtime: FakeRuntime
) -> None:
    app = create_app(settings=settings, runtime=fake_runtime)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://gamma.test",
            headers={TOKEN_HEADER: "test-token"},
        ) as client:
            await client.post("/api/sessions", json={"provider": "codex"})
            await client.post("/api/sessions", json={"provider": "codex"})
    assert [connection.alive for connection in fake_runtime.launched] == [False, False]


# --- resumable zeta sessions ----------------------------------------------


async def test_zeta_sessions_hides_sessions_outside_the_allowed_roots(
    client: httpx.AsyncClient, workspace: Path, fake_runtime: FakeRuntime
) -> None:
    fake_runtime.sessions.extend(
        [
            {
                "version": 1,
                "session_id": "inside",
                "provider": "codex",
                "model": "gpt-5.6-luna",
                "cwd": str(workspace / "project"),
                "updated_at": "2026-01-01T00:00:00+00:00",
                "first_message_preview": "hello there",
            },
            {
                "version": 1,
                "session_id": "outside",
                "provider": "codex",
                "model": "gpt-5.6-luna",
                "cwd": "/etc",
                "updated_at": "2026-01-01T00:00:00+00:00",
            },
        ]
    )
    body = (await client.get("/api/zeta-sessions", params={"provider": "codex"})).json()
    assert [item["session_id"] for item in body["sessions"]] == ["inside"]
    assert body["sessions"][0]["first_message_preview"] == "hello there"
    # The listing harness is transient: it must not stay open.
    assert not fake_runtime.launched[-1].alive


async def test_resume_opens_the_requested_zeta_session(
    client: httpx.AsyncClient, workspace: Path, fake_runtime: FakeRuntime
) -> None:
    response = await client.post(
        "/api/sessions",
        json={
            "provider": "codex",
            "resume_session_id": "old-session",
            "cwd": str(workspace / "project"),
        },
    )
    assert response.status_code == 201
    assert response.json()["zeta_session_id"] == "old-session"
    assert ("resume", {"session_id": "old-session"}) in fake_runtime.last.calls
    # zeta serve applies its launch --cwd to resumed sessions, so gamma must
    # relaunch the harness in the session's own directory.
    assert fake_runtime.last.spec.cwd == str(workspace / "project")
