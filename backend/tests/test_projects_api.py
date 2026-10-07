"""Read-only project endpoints, over a fake zeta serve that speaks the feature.

These tests cover the whole chain: feature negotiation (present and absent),
error mapping (unknown project, damaged storage, bad parameters), paging, the
cross-provider session merge, and the inbox untrusted flag.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import httpx
import pytest

from gamma.app import create_app
from gamma.config import Settings
from gamma.security import TOKEN_HEADER
from gamma.zeta_protocol import ZetaRpcError

from .support import FakeRuntime, ProjectsFixture

PROJECT_ID = "p_0123456789abcdef0123456789abcdef"


def _summary(**overrides: object) -> dict[str, object]:
    base = {
        "id": PROJECT_ID,
        "name": "zeta",
        "scope": "git",
        "roots": ["/work/zeta"],
        "session_count": 3,
        "last_activity": "2026-10-07T12:00:00.000000Z",
    }
    base.update(overrides)
    return base


def _detail() -> dict[str, object]:
    return {
        "project": {
            **_summary(),
            "created_at": "2026-10-01T12:00:00.000000Z",
            "updated_at": "2026-10-07T12:00:00.000000Z",
        },
        "memory": {
            "version_id": "0123456789abcdef0123456789abcdef",
            "digest": "a" * 64,
            "files": [
                {
                    "name": "brief.md",
                    "content": "# Brief\n",
                    "automatic": False,
                    "content_truncated": False,
                },
                {
                    "name": "state.md",
                    "content": "# State\n",
                    "automatic": True,
                    "content_truncated": False,
                },
                {
                    "name": "backlog.md",
                    "content": "",
                    "automatic": False,
                    "content_truncated": False,
                },
                {
                    "name": "changelog.md",
                    "content": "",
                    "automatic": False,
                    "content_truncated": False,
                },
                {
                    "name": "decisions.md",
                    "content": "",
                    "automatic": False,
                    "content_truncated": False,
                },
            ],
        },
    }


def _fixture() -> ProjectsFixture:
    return ProjectsFixture(
        projects=[_summary(), _summary(id="p_second", name="gamma", session_count=1)],
        details={PROJECT_ID: _detail()},
        memory_log={
            PROJECT_ID: [
                {
                    "version_id": "v1",
                    "timestamp": "2026-10-06T10:00:00.000000Z",
                    "kind": "update",
                    "files_changed": ["state.md"],
                    "provenance": {
                        "session_id": "s1",
                        "seq_start": 10,
                        "seq_end": 20,
                        "model": "gpt-5.6-luna",
                    },
                },
                {
                    "version_id": "v2",
                    "timestamp": "2026-10-07T10:00:00.000000Z",
                    "kind": "accept",
                    "files_changed": ["brief.md"],
                    "provenance": {"accepted_by": "henry"},
                },
            ]
        },
        memory_versions={
            (PROJECT_ID, "v1", "state.md"): {
                "version_id": "v1",
                "timestamp": "2026-10-06T10:00:00.000000Z",
                "kind": "update",
                "files_changed": ["state.md"],
                "provenance": {"session_id": "s1"},
                "file": "state.md",
                "content": "new state\n",
                "content_truncated": False,
                "diff": "--- state.md@parent\n+++ state.md@v1\n+new state\n",
                "diff_truncated": False,
            }
        },
        inbox={
            (PROJECT_ID, "new"): {
                "status": "new",
                "messages": [
                    {
                        "id": "m1",
                        "origin": "local",
                        "from": {"project": "gamma", "session": "s9"},
                        "to_project": PROJECT_ID,
                        "kind": "question",
                        "title": "ping",
                        "body": "how?",
                        "in_reply_to": None,
                        "created_at": "2026-10-07T09:00:00.000000Z",
                    },
                ],
                "untrusted": False,
                "next_offset": None,
            },
            (PROJECT_ID, "done"): {
                "status": "done",
                "messages": [
                    {
                        "id": "m2",
                        "origin": "remote",
                        "from": {"project": "peer", "session": "s8"},
                        "to_project": PROJECT_ID,
                        "kind": "info",
                        "title": "fyi",
                        "body": "done",
                        "in_reply_to": None,
                        "created_at": "2026-10-06T09:00:00.000000Z",
                        "claimer_session": "sa",
                        "claimed_at": "2026-10-06T09:05:00.000000Z",
                        "outcome": "ack",
                        "reply": None,
                        "done_at": "2026-10-06T09:10:00.000000Z",
                    },
                ],
                "untrusted": True,
                "next_offset": None,
            },
        },
        sessions=[
            {
                "version": 1,
                "session_id": "orc",
                "created_at": "2026-10-07T00:00:00+00:00",
                "updated_at": "2026-10-07T00:00:00+00:00",
                "provider": "fake",
                "model": "offline",
                "cwd": "/work/zeta",
                "name": "orchestrator",
                "project_id": PROJECT_ID,
                "project_role": "orchestrator",
                "parent_session_id": None,
            },
            {
                "version": 1,
                "session_id": "child",
                "created_at": "2026-10-07T00:00:00+00:00",
                "updated_at": "2026-10-07T00:00:00+00:00",
                "provider": "fake",
                "model": "offline",
                "cwd": "/work/zeta",
                "name": "worker",
                "project_id": PROJECT_ID,
                "project_role": "worker",
                "parent_session_id": "orc",
            },
            {
                "version": 1,
                "session_id": "other",
                "created_at": "2026-10-07T00:00:00+00:00",
                "updated_at": "2026-10-07T00:00:00+00:00",
                "provider": "fake",
                "model": "offline",
                "cwd": "/work/other",
                "name": "elsewhere",
                "project_id": "p_second",
                "project_role": None,
                "parent_session_id": None,
            },
        ],
    )


async def _make_client(
    settings: Settings, runtime: FakeRuntime
) -> AsyncIterator[httpx.AsyncClient]:
    app = create_app(settings=settings, runtime=runtime)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://gamma.test",
            headers={TOKEN_HEADER: "test-token"},
        ) as http_client:
            yield http_client


@pytest.fixture
async def client(settings: Settings) -> AsyncIterator[httpx.AsyncClient]:
    runtime = FakeRuntime(projects=_fixture())
    async for http_client in _make_client(settings, runtime):
        yield http_client


# --- feature negotiation ---------------------------------------------------


async def test_projects_need_a_token(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/projects", headers={TOKEN_HEADER: ""})
    assert response.status_code == 401


async def test_feature_absent_is_501_update_zeta(settings: Settings) -> None:
    runtime = FakeRuntime()  # no projects fixture: the handshake omits the feature
    async for http_client in _make_client(settings, runtime):
        response = await http_client.get("/api/projects")
        assert response.status_code == 501
        assert "update zeta" in response.json()["detail"].lower()


# --- list and show ---------------------------------------------------------


async def test_list_projects_returns_names_ids_and_counts(client: httpx.AsyncClient) -> None:
    body = (await client.get("/api/projects")).json()
    assert [item["name"] for item in body["projects"]] == ["zeta", "gamma"]
    assert body["projects"][0]["id"] == PROJECT_ID
    assert body["projects"][0]["session_count"] == 3
    assert body["next_offset"] is None


async def test_list_projects_pages(client: httpx.AsyncClient) -> None:
    body = (await client.get("/api/projects?offset=0&limit=1")).json()
    assert [item["name"] for item in body["projects"]] == ["zeta"]
    assert body["next_offset"] == 1
    body = (await client.get("/api/projects?offset=1&limit=1")).json()
    assert [item["name"] for item in body["projects"]] == ["gamma"]
    assert body["next_offset"] is None


async def test_show_project_lists_the_five_memory_files(client: httpx.AsyncClient) -> None:
    body = (await client.get(f"/api/projects/{PROJECT_ID}")).json()
    assert body["project"]["name"] == "zeta"
    assert body["project"]["created_at"] == "2026-10-01T12:00:00.000000Z"
    names = [item["name"] for item in body["memory"]["files"]]
    assert names == ["brief.md", "state.md", "backlog.md", "changelog.md", "decisions.md"]
    state = next(item for item in body["memory"]["files"] if item["name"] == "state.md")
    assert state["automatic"] is True
    assert body["memory"]["digest"] == "a" * 64


async def test_unknown_project_is_404(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/projects/p_missing")
    assert response.status_code == 404


# --- memory log and versions ----------------------------------------------


async def test_memory_log_lists_versions_with_provenance(client: httpx.AsyncClient) -> None:
    body = (await client.get(f"/api/projects/{PROJECT_ID}/memory/log")).json()
    assert [item["version_id"] for item in body["versions"]] == ["v1", "v2"]
    assert body["versions"][0]["provenance"]["model"] == "gpt-5.6-luna"
    assert body["versions"][1]["kind"] == "accept"
    assert body["versions"][1]["provenance"]["accepted_by"] == "henry"


async def test_memory_version_returns_content_and_diff(client: httpx.AsyncClient) -> None:
    body = (await client.get(f"/api/projects/{PROJECT_ID}/memory/versions/v1?file=state.md")).json()
    assert body["file"] == "state.md"
    assert body["content"] == "new state\n"
    assert "+new state" in body["diff"]


async def test_memory_version_rejects_an_unknown_file(client: httpx.AsyncClient) -> None:
    response = await client.get(f"/api/projects/{PROJECT_ID}/memory/versions/v1?file=not_a_file.md")
    assert response.status_code == 400


# --- sessions --------------------------------------------------------------


async def test_sessions_only_lists_the_project_and_keeps_roles(client: httpx.AsyncClient) -> None:
    body = (await client.get(f"/api/projects/{PROJECT_ID}/sessions")).json()
    ids = {item["session_id"] for item in body["sessions"]}
    assert ids == {"orc", "child"}
    child = next(item for item in body["sessions"] if item["session_id"] == "child")
    assert child["project_role"] == "worker"
    assert child["parent_session_id"] == "orc"
    assert child["name"] == "worker"


# --- inbox -----------------------------------------------------------------


async def test_inbox_new_is_local_and_not_untrusted(client: httpx.AsyncClient) -> None:
    body = (await client.get(f"/api/projects/{PROJECT_ID}/inbox")).json()
    assert body["status"] == "new"
    assert body["untrusted"] is False
    message = body["messages"][0]
    assert message["origin"] == "local"
    assert message["from_project"] == "gamma"
    assert message["kind"] == "question"


async def test_inbox_done_marks_untrusted_remote_origin(client: httpx.AsyncClient) -> None:
    body = (await client.get(f"/api/projects/{PROJECT_ID}/inbox?status=done")).json()
    assert body["untrusted"] is True
    assert body["messages"][0]["origin"] == "remote"
    assert body["messages"][0]["outcome"] == "ack"


async def test_inbox_rejects_an_unknown_status(client: httpx.AsyncClient) -> None:
    response = await client.get(f"/api/projects/{PROJECT_ID}/inbox?status=weird")
    assert response.status_code == 400


# --- storage errors --------------------------------------------------------


async def test_storage_error_is_502(settings: Settings) -> None:
    runtime = FakeRuntime(projects=_fixture())
    runtime.errors["project_show"] = ZetaRpcError(-32000, "bad storage")
    async for http_client in _make_client(settings, runtime):
        response = await http_client.get(f"/api/projects/{PROJECT_ID}")
        assert response.status_code == 502
        assert "invalid or unavailable" in response.json()["detail"]
