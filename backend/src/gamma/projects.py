"""Read-only project views, over a short-lived ``zeta serve`` connection.

``zeta serve`` exposes the project registry, memory store, session list, and
inbox through the optional ``projects`` feature. None of it needs an attached
session, so :class:`ProjectsService` opens a throw-away harness per request,
runs the read, and closes it again (the same pattern as listing resumable
sessions). The browser never picks a provider for these reads; the service
chooses one internally.

This module is the one place that interprets the project wire shapes. The
memory content a project returns is read here and nowhere else, so the planned
Zeta memory rewrite (an entry-shaped response under a new negotiated version)
changes :meth:`ProjectsService.show` and the memory helpers alone.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Any, Protocol, TypeVar

from .config import Settings
from .policy import LaunchPolicy, PolicyError
from .runtime import RuntimeConnection, RuntimeLaunchError, RuntimeSpec, ZetaRuntime
from .zeta_protocol import (
    LIST_SESSIONS_PAGING_FEATURE,
    PROJECTS_FEATURE,
    InboxMessage,
    MemoryLogResult,
    MemoryVersion,
    MemoryVersionResult,
    ProjectInboxResult,
    ProjectListResult,
    ProjectSessionsResult,
    ProjectShowResult,
    ProjectSummary,
    SessionMetadata,
    ZetaProtocolError,
    ZetaRpcError,
)

logger = logging.getLogger(__name__)

MEMORY_FILES = ("brief.md", "state.md", "backlog.md", "changelog.md", "decisions.md")
"""The five memory files, in the order the protocol guarantees."""

INBOX_STATUSES = ("new", "claimed", "done")

MAX_SESSION_PAGES = 1000
"""Safety bound on how many pages one provider's session list can span.

Each page carries up to the frame limit of sessions, so this spans far more
than any real project. It only stops a server that never advances
``next_offset`` from looping forever."""

PAGE_LIMIT = 1000
"""Largest page ``list_projects``, ``project_memory_log``, and ``project_inbox``
accept (serve-protocol.md). Asking for it keeps a full read to a handful of
round trips over one connection."""

_DEFAULT_WALK_DEADLINE = 10.0
"""Seconds one paged read may run before it returns what it has so far."""

_DEFAULT_WALK_PAGE_CAP = 50
"""Most pages one paged read follows. At :data:`PAGE_LIMIT` records each this
is far above any real project; it only bounds a server that never ends."""

# JSON-RPC error codes the projects requests use (serve-protocol.md).
_PROJECT_NOT_FOUND_DATA = "project_not_found"
_STORAGE_ERROR_CODE = -32000
_BAD_PARAMS_CODE = -32602


class ProjectsError(Exception):
    """A project read cannot be served."""


class ProjectsUnsupported(ProjectsError):
    """The running Zeta does not offer the ``projects`` feature."""


class ProjectNotFound(ProjectsError):
    """No project has the requested id."""

    def __init__(self, project_id: str) -> None:
        super().__init__(f"no project {project_id!r}")
        self.project_id = project_id


class ProjectStorageError(ProjectsError):
    """The stored project data is invalid or unavailable."""


class ProjectBadRequest(ProjectsError):
    """The request names an unknown file, version, or parameter."""


class ProjectUnavailable(ProjectsError):
    """The harness could not be launched or reached for this read."""


class ProjectTimeout(ProjectsError):
    """A paged read returned no page before the walk deadline ran out.

    This is a gateway timeout: the harness answered nothing in time, so there
    is no partial list to return. A walk that already collected a page never
    raises this; it returns that page with ``complete=False`` instead.
    """


@dataclass(frozen=True)
class PagedProjects:
    """Every project a bounded walk collected and whether it reached the end."""

    projects: list[ProjectSummary]
    complete: bool


@dataclass(frozen=True)
class PagedMemoryLog:
    """Every memory version a bounded walk collected, oldest first."""

    versions: list[MemoryVersion]
    complete: bool


@dataclass(frozen=True)
class PagedInbox:
    """Every inbox message a bounded walk collected for one status."""

    status: str
    messages: list[InboxMessage]
    untrusted: bool
    complete: bool


class _WalkedPage(Protocol):
    """One page of a paged request: enough to follow ``next_offset``."""

    next_offset: int | None


_PageT = TypeVar("_PageT", bound=_WalkedPage)


class ProjectsService:
    """Read project metadata, memory, sessions, and inbox from Zeta."""

    def __init__(
        self,
        *,
        runtime: ZetaRuntime,
        settings: Settings,
        walk_deadline: float = _DEFAULT_WALK_DEADLINE,
        walk_page_cap: int = _DEFAULT_WALK_PAGE_CAP,
    ) -> None:
        self._runtime = runtime
        self._settings = settings
        self._policy = LaunchPolicy(settings)
        self._walk_deadline = walk_deadline
        self._walk_page_cap = walk_page_cap

    async def list_projects(self) -> PagedProjects:
        """Every project, read to the end over one short-lived connection."""

        async with self._connect() as connection:
            pages, complete = await self._walk(
                connection, "list_projects", {}, ProjectListResult.model_validate
            )
        projects = [item for page in pages for item in page.projects]
        return PagedProjects(projects=projects, complete=complete)

    async def show(self, project_id: str) -> ProjectShowResult:
        async with self._connect() as connection:
            result = await self._call(connection, "project_show", {"project_id": project_id})
            return ProjectShowResult.model_validate(result)

    async def memory_log(self, project_id: str) -> PagedMemoryLog:
        """The whole memory history, oldest first, over one connection."""

        async with self._connect() as connection:
            pages, complete = await self._walk(
                connection,
                "project_memory_log",
                {"project_id": project_id},
                MemoryLogResult.model_validate,
            )
        versions = [item for page in pages for item in page.versions]
        return PagedMemoryLog(versions=versions, complete=complete)

    async def memory_version(
        self, project_id: str, version_id: str, file: str
    ) -> MemoryVersionResult:
        if file not in MEMORY_FILES:
            raise ProjectBadRequest(f"unknown memory file {file!r}")
        params = {"project_id": project_id, "version_id": version_id, "file": file}
        async with self._connect() as connection:
            result = await self._call(connection, "project_memory_log", params)
            return MemoryVersionResult.model_validate(result)

    async def inbox(
        self,
        project_id: str,
        *,
        status: str = "new",
    ) -> PagedInbox:
        """Every inbox message for one status, read to the end over one connection.

        ``untrusted`` is ``True`` when any collected page held a non-local
        message, so the browser warns once for the whole list.
        """

        if status not in INBOX_STATUSES:
            raise ProjectBadRequest(f"unknown inbox status {status!r}")
        async with self._connect() as connection:
            pages, complete = await self._walk(
                connection,
                "project_inbox",
                {"project_id": project_id, "status": status},
                ProjectInboxResult.model_validate,
            )
        messages = [item for page in pages for item in page.messages]
        untrusted = any(page.untrusted for page in pages)
        return PagedInbox(status=status, messages=messages, untrusted=untrusted, complete=complete)

    async def sessions(self, project_id: str) -> ProjectSessionsResult:
        """Sessions linked to one project, merged across the allowed providers.

        ``list_sessions`` filters by the harness's own launch provider (a fake
        server lists only fake sessions, a real server omits them), so one
        connection cannot see a project's whole session set. The service asks
        every allowed provider and merges by session id. A provider that fails
        to launch is skipped, so one bad provider does not hide the rest.

        Each provider is read to the end: with the ``list_sessions_paging``
        feature the service follows ``next_offset`` and merges every page, so
        the frame bound never hides sessions. A server without that feature can
        only return the largest fitting prefix, so a frame-bound page reports
        ``truncated`` instead of silently dropping the rest.
        """

        merged: dict[str, SessionMetadata] = {}
        truncated = False
        launched = 0
        last_error: Exception | None = None
        for provider in self._providers():
            try:
                async with self._connect(provider) as connection:
                    sessions, provider_truncated = await self._list_project_sessions(
                        connection, project_id
                    )
            except (RuntimeLaunchError, ProjectUnavailable) as exc:
                last_error = exc
                logger.warning("project sessions: provider %s unavailable: %s", provider, exc)
                continue
            launched += 1
            truncated = truncated or provider_truncated
            for session in sessions:
                merged.setdefault(session.session_id, session)
        if launched == 0 and last_error is not None:
            raise ProjectUnavailable(str(last_error))
        return ProjectSessionsResult(sessions=list(merged.values()), truncated=truncated)

    async def _list_project_sessions(
        self, connection: RuntimeConnection, project_id: str
    ) -> tuple[list[SessionMetadata], bool]:
        """One provider's project sessions, following ``next_offset`` paging.

        Returns the sessions and whether the list is incomplete. With paging
        the list is always complete (incomplete only if a server never
        advances ``next_offset``); without paging a frame-bound page is
        reported as incomplete so the caller can warn.
        """

        if not connection.supports_feature(LIST_SESSIONS_PAGING_FEATURE):
            result = await self._call(connection, "list_sessions", {"project_id": project_id})
            page = ProjectSessionsResult.model_validate(result)
            return list(page.sessions), page.truncated
        sessions: list[SessionMetadata] = []
        offset = 0
        for _ in range(MAX_SESSION_PAGES):
            result = await self._call(
                connection, "list_sessions", {"project_id": project_id, "offset": offset}
            )
            page = ProjectSessionsResult.model_validate(result)
            sessions.extend(page.sessions)
            next_offset = page.next_offset
            if next_offset is None:
                return sessions, False
            if next_offset <= offset:
                break
            offset = next_offset
        return sessions, True

    # --- connection and errors --------------------------------------------

    def _providers(self) -> list[str]:
        return list(self._settings.allowed_providers)

    def _read_provider(self) -> str:
        """A cheap provider for project-level reads (not session filtering).

        Project, memory, and inbox reads are provider-independent, so ``fake``
        is preferred: it needs no credentials and starts fastest.
        """

        providers = self._providers()
        if not providers:
            raise ProjectUnavailable("no provider is allowed")
        return "fake" if "fake" in providers else providers[0]

    @contextlib.asynccontextmanager
    async def _connect(self, provider: str | None = None) -> AsyncIterator[RuntimeConnection]:
        chosen = provider or self._read_provider()
        try:
            spec = self._resolve(chosen)
        except PolicyError as exc:
            raise ProjectUnavailable(str(exc)) from exc
        connection = await self._runtime.launch(spec, _ignore_events)
        try:
            if not connection.supports_feature(PROJECTS_FEATURE):
                raise ProjectsUnsupported(
                    "this Zeta server does not offer the projects feature; update Zeta"
                )
            yield connection
        finally:
            with contextlib.suppress(Exception):
                await connection.aclose()

    def _resolve(self, provider: str) -> RuntimeSpec:
        # Project reads do not depend on model or cwd; the policy still vets
        # the provider against the allowlist.
        return self._policy.resolve(provider=provider, model=None, cwd=None)

    async def _call(
        self, connection: RuntimeConnection, method: str, params: dict[str, Any]
    ) -> dict[str, Any]:
        try:
            return await connection.call(method, params)
        except ZetaRpcError as exc:
            raise _translate(exc) from exc
        except ZetaProtocolError as exc:
            raise ProjectUnavailable(str(exc)) from exc

    async def _call_bounded(
        self,
        connection: RuntimeConnection,
        method: str,
        params: dict[str, Any],
        budget: float,
    ) -> dict[str, Any]:
        """One paged call, bounded by the remaining walk budget.

        Without this, a single page waits for the connection's whole request
        timeout (30 s), so one slow page can run far past the walk deadline and,
        on expiry, raise a bare ``TimeoutError`` that escapes the walk. Here the
        call is capped at the time the walk has left and a timeout surfaces as
        :class:`ProjectTimeout`, which the walk turns into a partial result or a
        gateway-timeout error.
        """

        try:
            async with asyncio.timeout(budget):
                return await self._call(connection, method, params)
        except TimeoutError as exc:
            raise ProjectTimeout(f"{method} did not respond within the walk deadline") from exc

    async def _walk(
        self,
        connection: RuntimeConnection,
        method: str,
        base_params: dict[str, Any],
        parse: Callable[[dict[str, Any]], _PageT],
    ) -> tuple[list[_PageT], bool]:
        """Follow ``next_offset`` over one connection, bounded by time and pages.

        Each request asks for :data:`PAGE_LIMIT` records, so a list of any real
        size needs only a few round trips. Every call is capped at the time the
        walk has left, so a single hung page cannot outlast the deadline. The
        walk returns ``complete=True`` once a page reports ``next_offset: null``.
        It returns ``complete=False`` when it instead hits the page cap, the
        deadline, a server that stops advancing ``next_offset``, or a timeout or
        transport failure after at least one page was collected, so the caller
        can warn that the list may be short rather than hang or show a silent
        prefix. With no page collected yet, a timeout raises
        :class:`ProjectTimeout` and a transport failure or a semantic RPC error
        (invalid storage, unknown project) surfaces unchanged.
        """

        pages: list[_PageT] = []
        offset = 0
        deadline = time.monotonic() + self._walk_deadline
        for _ in range(self._walk_page_cap):
            remaining = deadline - time.monotonic()
            if remaining <= 0 and pages:
                return pages, False
            params = {**base_params, "offset": offset, "limit": PAGE_LIMIT}
            try:
                raw = await self._call_bounded(connection, method, params, max(remaining, 0.0))
            except (ProjectTimeout, ProjectUnavailable):
                if pages:
                    return pages, False
                raise
            page = parse(raw)
            pages.append(page)
            next_offset = page.next_offset
            if next_offset is None:
                return pages, True
            if next_offset <= offset:
                return pages, False
            offset = next_offset
        return pages, False


def _translate(exc: ZetaRpcError) -> ProjectsError:
    data = exc.data if isinstance(exc.data, dict) else {}
    if exc.code == _BAD_PARAMS_CODE and data.get("code") == _PROJECT_NOT_FOUND_DATA:
        return ProjectNotFound(str(data.get("project_id", "")))
    if exc.code == _STORAGE_ERROR_CODE:
        return ProjectStorageError("project storage is invalid or unavailable")
    if exc.code == _BAD_PARAMS_CODE:
        return ProjectBadRequest(exc.message)
    return ProjectUnavailable(exc.message)


def _ignore_events(_event: Any) -> None:
    return None


__all__ = [
    "INBOX_STATUSES",
    "MEMORY_FILES",
    "PagedInbox",
    "PagedMemoryLog",
    "PagedProjects",
    "ProjectBadRequest",
    "ProjectNotFound",
    "ProjectStorageError",
    "ProjectTimeout",
    "ProjectUnavailable",
    "ProjectsError",
    "ProjectsService",
    "ProjectsUnsupported",
]
