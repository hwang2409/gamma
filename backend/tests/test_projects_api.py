"""Read-only project endpoints, over a fake zeta serve that speaks the feature.

These tests cover the whole chain: feature negotiation (present and absent),
error mapping (unknown project, damaged storage, bad parameters), paging, the
cross-provider session merge, and the inbox untrusted flag.
"""

from __future__ import annotations

import time
from collections.abc import AsyncIterator

import httpx
import pytest

from gamma.app import create_app
from gamma.config import Settings
from gamma.projects import ProjectsService, ProjectTimeout
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
                "provider": "codex",
                "model": "gpt-5.6-luna",
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
                "provider": "codex",
                "model": "gpt-5.6-luna",
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
                "provider": "codex",
                "model": "gpt-5.6-luna",
                "cwd": "/work/other",
                "name": "elsewhere",
                "project_id": "p_second",
                "project_role": None,
                "parent_session_id": None,
            },
        ],
    )


async def _make_client(
    settings: Settings, runtime: FakeRuntime, *, walk_deadline: float | None = None
) -> AsyncIterator[httpx.AsyncClient]:
    app = create_app(settings=settings, runtime=runtime)
    if walk_deadline is not None:
        app.state.projects = ProjectsService(
            runtime=runtime, settings=settings, walk_deadline=walk_deadline
        )
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
    assert body["complete"] is True


async def test_list_projects_walks_every_page_over_one_connection(settings: Settings) -> None:
    # One record per page, so the whole list is reachable only by following
    # ``next_offset``. The browser still sends a single request.
    projects = [_summary(id=f"p_{index}", name=f"project {index}") for index in range(5)]
    runtime = FakeRuntime(projects=ProjectsFixture(projects=projects, page_size=1))
    async for http_client in _make_client(settings, runtime):
        body = (await http_client.get("/api/projects")).json()
        assert [item["id"] for item in body["projects"]] == [f"p_{index}" for index in range(5)]
        assert body["complete"] is True
        # One browser request launched exactly one serve harness, not one per page.
        assert len(runtime.launched) == 1
        calls = runtime.launched[0].calls
        assert [method for method, _ in calls] == ["list_projects"] * 5
        # Every page asks for the documented maximum page size.
        assert all(params.get("limit") == 1000 for _, params in calls)
        assert [params.get("offset") for _, params in calls] == [0, 1, 2, 3, 4]


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


async def test_memory_log_walks_every_page_over_one_connection(settings: Settings) -> None:
    versions = [
        {
            "version_id": f"v{index}",
            "kind": "update",
            "files_changed": ["state.md"],
            "provenance": {},
        }
        for index in range(4)
    ]
    fixture = ProjectsFixture(
        details={PROJECT_ID: _detail()},
        memory_log={PROJECT_ID: versions},
        page_size=1,
    )
    runtime = FakeRuntime(projects=fixture)
    async for http_client in _make_client(settings, runtime):
        body = (await http_client.get(f"/api/projects/{PROJECT_ID}/memory/log")).json()
        ids = [item["version_id"] for item in body["versions"]]
        assert ids == [f"v{index}" for index in range(4)]
        assert body["complete"] is True
        assert len(runtime.launched) == 1
        calls = runtime.launched[0].calls
        assert all(params.get("limit") == 1000 for _, params in calls)


# --- sessions --------------------------------------------------------------


async def test_sessions_only_lists_the_project_and_keeps_roles(client: httpx.AsyncClient) -> None:
    body = (await client.get(f"/api/projects/{PROJECT_ID}/sessions")).json()
    ids = {item["session_id"] for item in body["sessions"]}
    assert ids == {"orc", "child"}
    child = next(item for item in body["sessions"] if item["session_id"] == "child")
    assert child["project_role"] == "worker"
    assert child["parent_session_id"] == "orc"
    assert child["name"] == "worker"


def _many_sessions(count: int) -> list[dict[str, object]]:
    return [
        {
            "version": 1,
            "session_id": f"s{index}",
            "created_at": "2026-10-07T00:00:00+00:00",
            "updated_at": "2026-10-07T00:00:00+00:00",
            "provider": "codex",
            "model": "gpt-5.6-luna",
            "cwd": "/work/zeta",
            "name": f"session {index}",
            "project_id": PROJECT_ID,
            "project_role": None,
            "parent_session_id": None,
        }
        for index in range(count)
    ]


async def test_sessions_follow_paging_and_merge_every_page(settings: Settings) -> None:
    fixture = ProjectsFixture(
        details={PROJECT_ID: _detail()},
        sessions=_many_sessions(7),
        session_paging=True,
        session_page_size=3,
    )
    runtime = FakeRuntime(projects=fixture)
    async for http_client in _make_client(settings, runtime):
        body = (await http_client.get(f"/api/projects/{PROJECT_ID}/sessions")).json()
        ids = [item["session_id"] for item in body["sessions"]]
        assert ids == [f"s{index}" for index in range(7)]
        assert body["truncated"] is False


async def test_sessions_warn_when_paging_is_unavailable(settings: Settings) -> None:
    fixture = ProjectsFixture(
        details={PROJECT_ID: _detail()},
        sessions=_many_sessions(7),
        session_paging=False,
        session_page_size=3,
    )
    runtime = FakeRuntime(projects=fixture)
    async for http_client in _make_client(settings, runtime):
        body = (await http_client.get(f"/api/projects/{PROJECT_ID}/sessions")).json()
        ids = [item["session_id"] for item in body["sessions"]]
        assert ids == ["s0", "s1", "s2"]
        assert body["truncated"] is True


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


async def test_inbox_pages(settings: Settings) -> None:
    messages = [
        {
            "id": f"m{index}",
            "origin": "local",
            "from": {"project": "gamma", "session": "s9"},
            "to_project": PROJECT_ID,
            "kind": "question",
            "title": f"ping {index}",
            "body": "how?",
            "in_reply_to": None,
            "created_at": "2026-10-07T09:00:00.000000Z",
        }
        for index in range(5)
    ]
    # A remote message on a later page makes the whole merged page untrusted.
    messages[3]["origin"] = "remote"
    fixture = ProjectsFixture(
        details={PROJECT_ID: _detail()},
        inbox={(PROJECT_ID, "new"): {"status": "new", "messages": messages}},
        page_size=2,
    )
    runtime = FakeRuntime(projects=fixture)
    async for http_client in _make_client(settings, runtime):
        body = (await http_client.get(f"/api/projects/{PROJECT_ID}/inbox")).json()
        assert [item["id"] for item in body["messages"]] == [f"m{index}" for index in range(5)]
        assert body["untrusted"] is True
        assert body["complete"] is True
        assert len(runtime.launched) == 1
        calls = runtime.launched[0].calls
        assert all(params.get("limit") == 1000 for _, params in calls)


# --- bounded walk ----------------------------------------------------------


def _many_projects(count: int) -> list[dict[str, object]]:
    return [_summary(id=f"p_{index}", name=f"project {index}") for index in range(count)]


async def test_walk_stops_at_the_page_cap(settings: Settings) -> None:
    fixture = ProjectsFixture(projects=_many_projects(5), page_size=1)
    service = ProjectsService(
        runtime=FakeRuntime(projects=fixture), settings=settings, walk_page_cap=2
    )
    result = await service.list_projects()
    assert [item.id for item in result.projects] == ["p_0", "p_1"]
    assert result.complete is False


async def test_walk_returns_collected_pages_when_a_later_page_hangs(settings: Settings) -> None:
    # Page 1 returns; page 2 hangs forever. The per-call deadline must cut the
    # hang and return page 1 with complete=False, not wait for the request
    # timeout. The whole call finishes within the walk deadline plus slack.
    fixture = ProjectsFixture(projects=_many_projects(5), page_size=1, hang_on_page=2)
    service = ProjectsService(
        runtime=FakeRuntime(projects=fixture), settings=settings, walk_deadline=0.2
    )
    start = time.monotonic()
    result = await service.list_projects()
    elapsed = time.monotonic() - start
    assert [item.id for item in result.projects] == ["p_0"]
    assert result.complete is False
    assert elapsed < 2.0  # far below the 30 s request timeout


async def test_walk_times_out_when_the_first_page_hangs(settings: Settings) -> None:
    # Nothing was collected, so there is no partial list to return: the walk
    # raises a gateway-timeout error instead of hanging or losing it as a 500.
    fixture = ProjectsFixture(projects=_many_projects(5), page_size=1, hang_on_page=1)
    service = ProjectsService(
        runtime=FakeRuntime(projects=fixture), settings=settings, walk_deadline=0.2
    )
    start = time.monotonic()
    with pytest.raises(ProjectTimeout):
        await service.list_projects()
    assert time.monotonic() - start < 2.0


async def test_first_page_hang_is_a_504(settings: Settings) -> None:
    fixture = ProjectsFixture(projects=_many_projects(5), page_size=1, hang_on_page=1)
    runtime = FakeRuntime(projects=fixture)
    async for http_client in _make_client(settings, runtime, walk_deadline=0.2):
        response = await http_client.get("/api/projects")
        assert response.status_code == 504


async def test_semantic_error_mid_walk_still_surfaces(settings: Settings) -> None:
    # Page 1 returns, page 2 raises invalid storage. Even though a page was
    # collected, a semantic RPC error is raised, not swallowed as a partial.
    fixture = ProjectsFixture(
        projects=_many_projects(5),
        page_size=1,
        error_on_page=2,
        page_error=ZetaRpcError(-32000, "bad storage"),
    )
    runtime = FakeRuntime(projects=fixture)
    async for http_client in _make_client(settings, runtime):
        response = await http_client.get("/api/projects")
        assert response.status_code == 502
        assert "invalid or unavailable" in response.json()["detail"]


async def test_transport_reset_on_a_later_page_returns_a_partial_list(
    settings: Settings,
) -> None:
    # Page 1 returns, then the connection resets. A reset after a page was
    # collected is a transport failure, so the walk keeps page 1 and reports
    # complete=False rather than losing it or raising.
    fixture = ProjectsFixture(projects=_many_projects(5), page_size=1, reset_on_page=2)
    service = ProjectsService(runtime=FakeRuntime(projects=fixture), settings=settings)
    result = await service.list_projects()
    assert [item.id for item in result.projects] == ["p_0"]
    assert result.complete is False


async def test_transport_reset_on_the_first_page_is_a_502(settings: Settings) -> None:
    # Nothing was collected when the connection reset, so there is no partial
    # list. A transport failure is an upstream failure (502), not a 500.
    fixture = ProjectsFixture(projects=_many_projects(5), page_size=1, reset_on_page=1)
    runtime = FakeRuntime(projects=fixture)
    async for http_client in _make_client(settings, runtime):
        response = await http_client.get("/api/projects")
        assert response.status_code == 502


# --- storage errors --------------------------------------------------------


async def test_storage_error_is_502(settings: Settings) -> None:
    runtime = FakeRuntime(projects=_fixture())
    runtime.errors["project_show"] = ZetaRpcError(-32000, "bad storage")
    async for http_client in _make_client(settings, runtime):
        response = await http_client.get(f"/api/projects/{PROJECT_ID}")
        assert response.status_code == 502
        assert "invalid or unavailable" in response.json()["detail"]
