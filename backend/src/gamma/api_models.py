"""Pydantic models for every gamma HTTP and WebSocket message."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .projects import PagedInbox, PagedMemoryLog, PagedProjects
from .session import RunState, SessionSnapshot
from .zeta_protocol import (
    InboxMessage,
    MemorySnapshot,
    MemoryVersion,
    MemoryVersionResult,
    PendingApproval,
    ProjectDetail,
    ProjectSessionsResult,
    ProjectShowResult,
    ProjectSummary,
    SessionMetadata,
)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


# --- REST ------------------------------------------------------------------


class ProviderOption(StrictModel):
    name: str
    models: list[str]


class OptionsResponse(StrictModel):
    """What the start page may offer: no free-form process arguments."""

    providers: list[ProviderOption]
    default_provider: str | None
    allowed_roots: list[str]
    directories: list[str]
    approval_mode: Literal["ask"] = "ask"


class ZetaSessionSummary(StrictModel):
    session_id: str
    provider: str
    model: str
    cwd: str
    name: str | None = None
    updated_at: str | None = None
    first_message_preview: str | None = None

    @classmethod
    def from_metadata(cls, metadata: SessionMetadata) -> ZetaSessionSummary:
        return cls(
            session_id=metadata.session_id,
            provider=metadata.provider,
            model=metadata.model,
            cwd=metadata.cwd,
            name=metadata.name or None,
            updated_at=metadata.updated_at,
            first_message_preview=metadata.first_message_preview,
        )


class ZetaSessionList(StrictModel):
    sessions: list[ZetaSessionSummary]


class SessionCreateRequest(StrictModel):
    provider: str
    model: str | None = None
    cwd: str | None = None
    resume_session_id: str | None = None


class SessionView(StrictModel):
    """A gamma session as the browser sees it."""

    session_id: str
    zeta_session_id: str | None
    provider: str
    model: str | None
    cwd: str | None
    protocol_version: str
    state: RunState
    usage: dict[str, Any] = Field(default_factory=dict)
    pending_approvals: list[PendingApproval] = Field(default_factory=list)
    cursor: int
    oldest_cursor: int
    created_at: float
    last_activity: float
    session_name: str | None = None
    first_prompt: str | None = None
    capabilities: list[str] = Field(default_factory=list)

    @classmethod
    def from_snapshot(cls, snapshot: SessionSnapshot) -> SessionView:
        return cls(
            session_id=snapshot.session_id,
            zeta_session_id=snapshot.zeta_session_id,
            provider=snapshot.provider,
            model=snapshot.model,
            cwd=snapshot.cwd,
            protocol_version=snapshot.protocol_version,
            state=snapshot.state,
            usage=snapshot.usage,
            pending_approvals=snapshot.pending_approvals,
            cursor=snapshot.cursor,
            oldest_cursor=snapshot.oldest_cursor,
            created_at=snapshot.created_at,
            last_activity=snapshot.last_activity,
            session_name=(snapshot.metadata.name or None) if snapshot.metadata else None,
            first_prompt=snapshot.first_prompt,
            capabilities=snapshot.capabilities,
        )


class SessionList(StrictModel):
    sessions: list[SessionView]


# --- REST: projects --------------------------------------------------------
#
# These views mirror the ``projects`` wire shapes one-to-one. Memory content
# interpretation lives in ``projects.py`` and these dumb carriers; a later
# memory rewrite changes the service and these fields together.


class ProjectSummaryView(StrictModel):
    id: str
    name: str
    scope: str | None
    roots: list[str]
    session_count: int
    last_activity: str | None

    @classmethod
    def from_wire(cls, project: ProjectSummary) -> ProjectSummaryView:
        return cls(
            id=project.id,
            name=project.name,
            scope=project.scope,
            roots=list(project.roots),
            session_count=project.session_count,
            last_activity=project.last_activity,
        )


class ProjectDetailView(ProjectSummaryView):
    created_at: str | None
    updated_at: str | None

    @classmethod
    def from_detail(cls, project: ProjectDetail) -> ProjectDetailView:
        return cls(
            id=project.id,
            name=project.name,
            scope=project.scope,
            roots=list(project.roots),
            session_count=project.session_count,
            last_activity=project.last_activity,
            created_at=project.created_at,
            updated_at=project.updated_at,
        )


class ProjectListView(StrictModel):
    projects: list[ProjectSummaryView]
    complete: bool = True

    @classmethod
    def from_wire(cls, result: PagedProjects) -> ProjectListView:
        return cls(
            projects=[ProjectSummaryView.from_wire(item) for item in result.projects],
            complete=result.complete,
        )


class MemoryFileView(StrictModel):
    name: str
    content: str
    automatic: bool
    content_truncated: bool


class MemorySnapshotView(StrictModel):
    version_id: str | None
    digest: str | None
    files: list[MemoryFileView]

    @classmethod
    def from_wire(cls, memory: MemorySnapshot) -> MemorySnapshotView:
        return cls(
            version_id=memory.version_id,
            digest=memory.digest,
            files=[
                MemoryFileView(
                    name=item.name,
                    content=item.content,
                    automatic=item.automatic,
                    content_truncated=item.content_truncated,
                )
                for item in memory.files
            ],
        )


class ProjectDetailResponse(StrictModel):
    project: ProjectDetailView
    memory: MemorySnapshotView

    @classmethod
    def from_wire(cls, result: ProjectShowResult) -> ProjectDetailResponse:
        return cls(
            project=ProjectDetailView.from_detail(result.project),
            memory=MemorySnapshotView.from_wire(result.memory),
        )


class MemoryVersionView(StrictModel):
    version_id: str
    timestamp: str | None
    kind: str | None
    files_changed: list[str]
    provenance: dict[str, Any]
    provenance_truncated: bool
    target_version_id: str | None

    @classmethod
    def from_wire(cls, version: MemoryVersion) -> MemoryVersionView:
        return cls(
            version_id=version.version_id,
            timestamp=version.timestamp,
            kind=version.kind,
            files_changed=list(version.files_changed),
            provenance=dict(version.provenance),
            provenance_truncated=version.provenance_truncated,
            target_version_id=version.target_version_id,
        )


class MemoryLogResponse(StrictModel):
    versions: list[MemoryVersionView]
    complete: bool = True

    @classmethod
    def from_wire(cls, result: PagedMemoryLog) -> MemoryLogResponse:
        return cls(
            versions=[MemoryVersionView.from_wire(item) for item in result.versions],
            complete=result.complete,
        )


class MemoryVersionResponse(MemoryVersionView):
    file: str
    content: str
    content_truncated: bool
    diff: str
    diff_truncated: bool

    @classmethod
    def from_version(cls, result: MemoryVersionResult) -> MemoryVersionResponse:
        version = result.version
        return cls(
            version_id=version.version_id,
            timestamp=version.timestamp,
            kind=version.kind,
            files_changed=list(version.files_changed),
            provenance=dict(version.provenance),
            provenance_truncated=version.provenance_truncated,
            target_version_id=version.target_version_id,
            file=version.file,
            content=version.content,
            content_truncated=version.content_truncated,
            diff=version.diff,
            diff_truncated=version.diff_truncated,
        )


class ProjectSessionView(StrictModel):
    session_id: str
    name: str | None
    provider: str
    model: str | None
    cwd: str | None
    project_role: str | None
    parent_session_id: str | None
    updated_at: str | None
    first_message_preview: str | None

    @classmethod
    def from_metadata(cls, metadata: SessionMetadata) -> ProjectSessionView:
        extra = metadata.model_dump(mode="json")
        return cls(
            session_id=metadata.session_id,
            name=metadata.name or None,
            provider=metadata.provider,
            model=metadata.model,
            cwd=metadata.cwd,
            project_role=extra.get("project_role"),
            parent_session_id=extra.get("parent_session_id"),
            updated_at=metadata.updated_at,
            first_message_preview=metadata.first_message_preview,
        )


class ProjectSessionsResponse(StrictModel):
    sessions: list[ProjectSessionView]
    truncated: bool = False

    @classmethod
    def from_wire(cls, result: ProjectSessionsResult) -> ProjectSessionsResponse:
        return cls(
            sessions=[ProjectSessionView.from_metadata(item) for item in result.sessions],
            truncated=result.truncated,
        )


class InboxMessageView(StrictModel):
    id: str
    origin: str
    from_project: str | None
    from_session: str | None
    to_project: str | None
    kind: str | None
    title: str
    body: str
    in_reply_to: str | None
    created_at: str | None
    claimer_session: str | None
    claimed_at: str | None
    outcome: str | None
    reply: str | None
    done_at: str | None
    truncated_fields: list[str]

    @classmethod
    def from_wire(cls, message: InboxMessage) -> InboxMessageView:
        sender = message.sender if isinstance(message.sender, dict) else {}
        return cls(
            id=message.id,
            origin=message.origin,
            from_project=sender.get("project"),
            from_session=sender.get("session"),
            to_project=message.to_project,
            kind=message.kind,
            title=message.title,
            body=message.body,
            in_reply_to=message.in_reply_to,
            created_at=message.created_at,
            claimer_session=message.claimer_session,
            claimed_at=message.claimed_at,
            outcome=message.outcome,
            reply=message.reply,
            done_at=message.done_at,
            truncated_fields=list(message.truncated_fields),
        )


class ProjectInboxResponse(StrictModel):
    status: str
    messages: list[InboxMessageView]
    untrusted: bool
    complete: bool = True

    @classmethod
    def from_wire(cls, result: PagedInbox) -> ProjectInboxResponse:
        return cls(
            status=result.status,
            messages=[InboxMessageView.from_wire(item) for item in result.messages],
            untrusted=result.untrusted,
            complete=result.complete,
        )


# --- WebSocket: browser to gamma -------------------------------------------


class AuthCommand(StrictModel):
    type: Literal["auth"]
    token: str


class SendCommand(StrictModel):
    type: Literal["send"]
    text: str = Field(min_length=1)


class SteerCommand(StrictModel):
    type: Literal["steer"]
    text: str = Field(min_length=1)


class DecisionCommand(StrictModel):
    type: Literal["approve", "deny"]
    request_id: str = Field(min_length=1)
    scope: Literal["once", "always_tool"] = "once"


class AbortCommand(StrictModel):
    type: Literal["abort"]


class PingCommand(StrictModel):
    type: Literal["ping"]


ClientCommand = (
    AuthCommand | SendCommand | SteerCommand | DecisionCommand | AbortCommand | PingCommand
)


class ClientFrame(StrictModel):
    """Envelope used to parse any browser command."""

    command: ClientCommand = Field(discriminator="type")


# --- WebSocket: gamma to browser -------------------------------------------


class SnapshotFrame(StrictModel):
    type: Literal["snapshot"] = "snapshot"
    session: SessionView
    replay_from: int


class EventFrame(StrictModel):
    type: Literal["event"] = "event"
    cursor: int
    at: float
    event: str
    payload: dict[str, Any] = Field(default_factory=dict)


class AckFrame(StrictModel):
    type: Literal["ack"] = "ack"
    command: str
    result: dict[str, Any] = Field(default_factory=dict)


class ErrorFrame(StrictModel):
    type: Literal["error"] = "error"
    message: str
    command: str | None = None


class PongFrame(StrictModel):
    type: Literal["pong"] = "pong"


__all__ = [
    "AbortCommand",
    "AckFrame",
    "AuthCommand",
    "ClientCommand",
    "ClientFrame",
    "DecisionCommand",
    "ErrorFrame",
    "EventFrame",
    "InboxMessageView",
    "MemoryFileView",
    "MemoryLogResponse",
    "MemorySnapshotView",
    "MemoryVersionResponse",
    "MemoryVersionView",
    "OptionsResponse",
    "PingCommand",
    "PongFrame",
    "ProjectDetailResponse",
    "ProjectDetailView",
    "ProjectInboxResponse",
    "ProjectListView",
    "ProjectSessionView",
    "ProjectSessionsResponse",
    "ProjectSummaryView",
    "ProviderOption",
    "SendCommand",
    "SessionCreateRequest",
    "SessionList",
    "SessionView",
    "SnapshotFrame",
    "SteerCommand",
    "ZetaSessionList",
    "ZetaSessionSummary",
]
