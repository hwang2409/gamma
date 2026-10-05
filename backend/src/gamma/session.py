"""Gamma sessions: one zeta harness plus its event bus and derived state.

A gamma session is the unit the browser attaches to. It owns one
:class:`~gamma.runtime.RuntimeConnection` (and therefore one ``zeta serve``
process, because that server takes one client and holds one session), one
:class:`~gamma.events.EventBus`, and the state the UI needs when it attaches
late: run state, usage totals, and unresolved approvals.

The zeta read loop is the event pump: every notification updates derived state
and is published to the bus under one cursor sequence.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal

from .config import Settings
from .events import EventBus, GammaEvent
from .policy import LaunchPolicy, PolicyError
from .runtime import RuntimeConnection, RuntimeSpec, ZetaRuntime
from .zeta_protocol import (
    PendingApproval,
    SessionMetadata,
    StatusResult,
    ToolCall,
    ZetaEvent,
    ZetaRpcError,
)

logger = logging.getLogger(__name__)

RunState = Literal["idle", "running", "tool"]

RUNNING_EVENTS = frozenset({"turn_start", "message_start", "agent_start", "retry"})
TOOL_EVENTS = frozenset({"tool_start", "tool_output", "approval_request"})
IDLE_EVENTS = frozenset({"turn_end", "turn_aborted", "agent_end", "error"})


class SessionError(Exception):
    """A session request cannot be served."""


class SessionNotFound(SessionError):
    pass


@dataclass
class SessionSnapshot:
    """Everything a newly attached client needs before it reads events."""

    session_id: str
    zeta_session_id: str | None
    provider: str
    model: str | None
    cwd: str | None
    protocol_version: str
    state: RunState
    usage: dict[str, Any]
    pending_approvals: list[PendingApproval]
    cursor: int
    oldest_cursor: int
    created_at: float
    last_activity: float
    metadata: SessionMetadata | None = None
    capabilities: list[str] = field(default_factory=list)


class GammaSession:
    def __init__(
        self,
        *,
        session_id: str,
        spec: RuntimeSpec,
        buffer_capacity: int,
    ) -> None:
        self.session_id = session_id
        self.spec = spec
        self.bus = EventBus(capacity=buffer_capacity)
        self.created_at = time.time()
        self.last_activity = self.created_at
        self.state: RunState = "idle"
        self.usage: dict[str, Any] = {}
        self.pending_approvals: dict[str, ToolCall] = {}
        self.metadata: SessionMetadata | None = None
        self._connection: RuntimeConnection | None = None
        self._closed = False

    # --- wiring ------------------------------------------------------------

    def attach(self, connection: RuntimeConnection) -> None:
        self._connection = connection

    @property
    def zeta_session_id(self) -> str | None:
        return self.metadata.session_id if self.metadata else None

    @property
    def alive(self) -> bool:
        return not self._closed and self._connection is not None and self._connection.alive

    def touch(self) -> None:
        self.last_activity = time.time()

    def snapshot(self) -> SessionSnapshot:
        hello = self._connection.hello if self._connection is not None else None
        return SessionSnapshot(
            session_id=self.session_id,
            zeta_session_id=self.zeta_session_id,
            provider=self.spec.provider,
            model=self.metadata.model if self.metadata else self.spec.model,
            cwd=self.metadata.cwd if self.metadata else self.spec.cwd,
            protocol_version=hello.protocol_version if hello else "unknown",
            state=self.state,
            usage=dict(self.usage),
            pending_approvals=[
                PendingApproval(request_id=request_id, tool_call=tool_call)
                for request_id, tool_call in self.pending_approvals.items()
            ],
            cursor=self.bus.cursor,
            oldest_cursor=self.bus.oldest_cursor,
            created_at=self.created_at,
            last_activity=self.last_activity,
            metadata=self.metadata,
            capabilities=list(hello.capabilities.requests) if hello else [],
        )

    # --- event pump --------------------------------------------------------

    def on_zeta_event(self, event: ZetaEvent) -> None:
        """Update derived state, then broadcast. Runs in the zeta read loop."""

        name = event.event
        fields = event.fields
        self.touch()
        if name in RUNNING_EVENTS:
            self.state = "running"
        elif name in TOOL_EVENTS:
            self.state = "tool"
        elif name in IDLE_EVENTS:
            self.state = "idle"
        if name == "usage":
            usage = fields.get("usage")
            if isinstance(usage, dict):
                self.usage = usage
        elif name == "approval_request":
            request_id = fields.get("request_id")
            tool_call = fields.get("tool_call")
            if isinstance(request_id, str) and isinstance(tool_call, dict):
                self.pending_approvals[request_id] = ToolCall.model_validate(tool_call)
        elif name in ("approval_end", "tool_end"):
            tool_call = fields.get("tool_call")
            call_id = tool_call.get("id") if isinstance(tool_call, dict) else None
            self._resolve_approvals(call_id)
        elif name in ("turn_end", "turn_aborted"):
            self.pending_approvals.clear()
        self.bus.publish(name, fields)

    def _resolve_approvals(self, tool_call_id: str | None) -> None:
        if tool_call_id is None:
            return
        for request_id, call in list(self.pending_approvals.items()):
            if call.id == tool_call_id or request_id == tool_call_id:
                self.pending_approvals.pop(request_id, None)

    def publish_local(self, event: str, payload: dict[str, Any]) -> GammaEvent:
        """Publish a gamma-generated event (not from zeta) on the same stream."""

        return self.bus.publish(event, payload)

    # --- commands ----------------------------------------------------------

    async def call(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        if not self.alive:
            raise SessionError("session harness is gone")
        self.touch()
        return await self._connection.call(method, params)

    async def send(self, text: str) -> dict[str, Any]:
        return await self.call("send", {"text": text})

    async def steer(self, text: str) -> dict[str, Any]:
        return await self.call("steer", {"text": text})

    async def abort(self) -> dict[str, Any]:
        return await self.call("abort", {})

    async def decide(
        self, *, request_id: str, approve: bool, scope: str = "once"
    ) -> dict[str, Any]:
        params: dict[str, Any] = {"request_id": request_id}
        if approve and scope != "once":
            params["scope"] = scope
        result = await self.call("approve" if approve else "deny", params)
        self.pending_approvals.pop(request_id, None)
        return result

    async def status(self) -> StatusResult:
        result = await self.call("status", {})
        status = StatusResult.model_validate(result)
        self.state = status.state
        if status.usage:
            self.usage = status.usage
        self.pending_approvals = {
            approval.request_id: approval.tool_call for approval in status.pending_approvals
        }
        if status.session is not None:
            self.metadata = status.session
        return status

    def supports(self, request: str) -> bool:
        return self._connection is not None and self._connection.supports(request)

    async def aclose(self) -> None:
        if self._closed:
            return
        self._closed = True
        self.bus.publish("gamma_session_closed", {})
        self.bus.close()
        if self._connection is not None:
            with contextlib.suppress(Exception):
                await self._connection.aclose()


class SessionManager:
    """Registry of gamma sessions over one runtime."""

    def __init__(self, *, runtime: ZetaRuntime, settings: Settings) -> None:
        self._runtime = runtime
        self._settings = settings
        self._policy = LaunchPolicy(settings)
        self._sessions: dict[str, GammaSession] = {}
        self._lock = asyncio.Lock()
        self._reaper: asyncio.Task[None] | None = None

    @property
    def policy(self) -> LaunchPolicy:
        return self._policy

    def start(self) -> None:
        if self._reaper is None:
            self._reaper = asyncio.create_task(self._reap_idle(), name="gamma-idle-reaper")

    def list(self) -> list[GammaSession]:
        return list(self._sessions.values())

    def get(self, session_id: str) -> GammaSession:
        try:
            return self._sessions[session_id]
        except KeyError:
            raise SessionNotFound(f"unknown gamma session {session_id}") from None

    async def create(
        self,
        *,
        provider: str,
        model: str | None = None,
        cwd: str | None = None,
        resume_session_id: str | None = None,
    ) -> GammaSession:
        """Launch a harness and open a zeta session in it."""

        spec = self._policy.resolve(provider=provider, model=model, cwd=cwd)
        async with self._lock:
            if len(self._sessions) >= self._settings.max_sessions:
                raise SessionError(
                    f"too many open sessions (limit is {self._settings.max_sessions})"
                )
            session = GammaSession(
                session_id=uuid.uuid4().hex[:12],
                spec=spec,
                buffer_capacity=self._settings.event_buffer_capacity,
            )
            self._sessions[session.session_id] = session
        try:
            connection = await self._runtime.launch(spec, session.on_zeta_event)
            session.attach(connection)
            if resume_session_id is not None:
                result = await session.call("resume", {"session_id": resume_session_id})
            else:
                params: dict[str, Any] = {"provider": spec.provider}
                if spec.model:
                    params["model"] = spec.model
                result = await session.call("new_session", params)
            session.metadata = SessionMetadata.model_validate(result["session"])
            session.publish_local(
                "gamma_session_ready",
                {"zeta_session_id": session.metadata.session_id},
            )
            return session
        except BaseException as exc:
            self._sessions.pop(session.session_id, None)
            await session.aclose()
            if isinstance(exc, ZetaRpcError):
                raise SessionError(exc.message) from exc
            raise

    async def close(self, session_id: str) -> None:
        session = self._sessions.pop(session_id, None)
        if session is None:
            raise SessionNotFound(f"unknown gamma session {session_id}")
        await session.aclose()

    async def list_zeta_sessions(self, provider: str) -> list[SessionMetadata]:
        """Resumable zeta sessions for a provider.

        ``list_sessions`` needs a connected zeta server, and a server filters
        by its own launch provider, so this opens a short-lived harness and
        closes it again.
        """

        spec = self._policy.resolve(provider=provider, model=None, cwd=None)
        connection = await self._runtime.launch(spec, lambda event: None)
        try:
            result = await connection.call("list_sessions", {})
        finally:
            await connection.aclose()
        sessions = [SessionMetadata.model_validate(item) for item in result.get("sessions", [])]
        if result.get("truncated"):
            logger.warning("zeta truncated list_sessions; showing the first page only")
        return [session for session in sessions if self._resumable(session)]

    def _resumable(self, session: SessionMetadata) -> bool:
        """Hide sessions gamma would refuse to open (cwd outside the roots).

        zeta serve applies its launch ``--cwd`` to resumed sessions too, so
        gamma must relaunch in the stored directory; a directory outside the
        allowed roots is not openable here.
        """

        try:
            self._policy.resolve_cwd(session.cwd)
        except PolicyError:
            return False
        return True

    async def aclose(self) -> None:
        if self._reaper is not None:
            self._reaper.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._reaper
            self._reaper = None
        sessions, self._sessions = list(self._sessions.values()), {}
        for session in sessions:
            with contextlib.suppress(Exception):
                await session.aclose()
        await self._runtime.aclose()

    async def _reap_idle(self) -> None:
        timeout = self._settings.session_idle_timeout_seconds
        while True:
            await asyncio.sleep(min(30.0, max(1.0, timeout / 4)))
            cutoff = time.time() - timeout
            for session in self.list():
                if session.last_activity < cutoff or not session.alive:
                    reason = "idle timeout" if session.alive else "harness exited"
                    logger.info("closing session %s: %s", session.session_id, reason)
                    with contextlib.suppress(SessionNotFound):
                        await self.close(session.session_id)


__all__ = [
    "GammaSession",
    "RunState",
    "SessionError",
    "SessionManager",
    "SessionNotFound",
    "SessionSnapshot",
]
