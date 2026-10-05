"""Pydantic models for every gamma HTTP and WebSocket message."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .session import RunState, SessionSnapshot
from .zeta_protocol import PendingApproval, SessionMetadata


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
            capabilities=snapshot.capabilities,
        )


class SessionList(StrictModel):
    sessions: list[SessionView]


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
    "OptionsResponse",
    "PingCommand",
    "PongFrame",
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
