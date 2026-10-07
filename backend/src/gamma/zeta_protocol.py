"""The zeta serve wire protocol, isolated.

Everything that knows about newline-delimited JSON-RPC 2.0, the ``hello``
handshake, request names, and event shapes lives here. The rest of gamma uses
:class:`ZetaConnection` and the typed models below, so a change in the zeta
protocol touches one module.

Contract: ``docs/serve-protocol.md`` (protocol 1.1) in the Zeta repository,
https://github.com/hwang2409/zeta.
"""

from __future__ import annotations

import asyncio
import contextlib
import itertools
import json
from collections.abc import Awaitable, Callable
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

MAX_FRAME_BYTES = 1024 * 1024
"""Frame limit of the zeta codec, including the newline."""

CLIENT_PROTOCOL_VERSION = "1.0"
"""Sent as ``protocol_version`` so a 1.0 server still accepts the handshake."""

CLIENT_VERSION = "1.1"
"""Sent as ``client_version``; a 1.1 server upgrades the connection to 1.1."""

PROJECTS_FEATURE = "projects"
"""Negotiated 1.1 feature: read-only project list, memory, sessions, inbox."""

LIST_SESSIONS_PAGING_FEATURE = "list_sessions_paging"
"""Negotiated 1.1 feature: ``list_sessions`` takes ``offset``/``limit`` and
always returns ``next_offset``, so a client can page past the frame bound."""

REQUESTED_FEATURES = ("assistant_reset", PROJECTS_FEATURE, LIST_SESSIONS_PAGING_FEATURE)
"""Optional (1.1) features gamma asks for; the server echoes the ones it has."""

REQUIRED_REQUESTS = frozenset(
    {
        "list_sessions",
        "new_session",
        "resume",
        "send",
        "steer",
        "approve",
        "deny",
        "abort",
        "status",
    }
)
"""Baseline (1.0) requests gamma cannot work without."""


# --- wire models -----------------------------------------------------------
#
# zeta sends more metadata fields than its document lists (for example
# ``compaction``, ``tool_allow``, ``project_id``). Models keep unknown keys
# instead of failing, so a zeta release that adds a field does not break gamma.


class WireModel(BaseModel):
    model_config = ConfigDict(extra="allow")


class SessionMetadata(WireModel):
    session_id: str
    provider: str
    model: str
    cwd: str
    created_at: str | None = None
    updated_at: str | None = None
    name: str | None = None
    approval_mode: str | None = None
    first_message_preview: str | None = None


class ToolCall(WireModel):
    id: str
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)


class ToolResult(WireModel):
    tool_call_id: str
    content: str = ""
    is_error: bool = False
    is_canceled: bool | None = None


class ContentBlock(WireModel):
    type: str
    text: str | None = None


class Message(WireModel):
    role: str
    content: list[ContentBlock] = Field(default_factory=list)


class ApprovalDisplay(WireModel):
    """Facts the harness resolved for an approval, beyond the model's arguments.

    zeta adds ``approval_display`` to ``approval_request`` events and to
    ``status.pending_approvals`` only when it resolved them: the directory a
    command runs in and the path it touches, or the project memory file a
    write targets with a preview of the new content. The model cannot forge
    these, so the approval card shows them next to the arguments.
    """

    effective_cwd: str | None = None
    resolved_path: str | None = None
    project_id: str | None = None
    project_name: str | None = None
    filename: str | None = None
    utf8_bytes: int | None = None
    preview: str | None = None


class PendingApproval(WireModel):
    request_id: str
    tool_call: ToolCall
    approval_display: ApprovalDisplay | None = None
    delegated: bool = False
    agent_instance_id: str | None = None


class StatusResult(WireModel):
    session: SessionMetadata | None = None
    state: Literal["idle", "running", "tool"] = "idle"
    pending_approvals: list[PendingApproval] = Field(default_factory=list)
    usage: dict[str, Any] = Field(default_factory=dict)
    compaction_markers: int = 0


# --- projects feature (1.1) ------------------------------------------------
#
# The ``projects`` feature adds four read-only requests and a ``project_id``
# filter on ``list_sessions``. These models mirror the shapes in the projects
# section of ``docs/serve-protocol.md``. Like every wire model they keep
# unknown keys, so a later memory rewrite that enriches a record does not drop
# data a newer gamma could use.


class ProjectSummary(WireModel):
    id: str
    name: str
    scope: str | None = None
    roots: list[str] = Field(default_factory=list)
    session_count: int = 0
    last_activity: str | None = None


class ProjectDetail(ProjectSummary):
    created_at: str | None = None
    updated_at: str | None = None


class MemoryFile(WireModel):
    name: str
    content: str = ""
    automatic: bool = False
    content_truncated: bool = False


class MemorySnapshot(WireModel):
    version_id: str | None = None
    digest: str | None = None
    files: list[MemoryFile] = Field(default_factory=list)


class MemoryVersion(WireModel):
    version_id: str
    timestamp: str | None = None
    kind: str | None = None
    files_changed: list[str] = Field(default_factory=list)
    provenance: dict[str, Any] = Field(default_factory=dict)
    provenance_truncated: bool = False
    target_version_id: str | None = None


class MemoryVersionDetail(MemoryVersion):
    file: str
    content: str = ""
    content_truncated: bool = False
    diff: str = ""
    diff_truncated: bool = False


class ProjectListResult(WireModel):
    projects: list[ProjectSummary] = Field(default_factory=list)
    next_offset: int | None = None
    truncated: bool = False


class ProjectShowResult(WireModel):
    project: ProjectDetail
    memory: MemorySnapshot = Field(default_factory=MemorySnapshot)


class MemoryLogResult(WireModel):
    versions: list[MemoryVersion] = Field(default_factory=list)
    next_offset: int | None = None
    truncated: bool = False


class MemoryVersionResult(WireModel):
    version: MemoryVersionDetail


class InboxMessage(WireModel):
    """One project-inbox message, as returned by inbox ``action: "list"``.

    Field names mirror the stored record: ``from`` is a reserved word, so it is
    exposed through :attr:`sender`. ``origin`` is ``"local"`` for same-home
    messages; any other value marks untrusted cross-project content.
    """

    id: str
    origin: str = "local"
    sender: dict[str, Any] = Field(default_factory=dict, alias="from")
    to_project: str | None = None
    kind: str | None = None
    title: str = ""
    body: str = ""
    in_reply_to: str | None = None
    created_at: str | None = None
    claimer_session: str | None = None
    claimed_at: str | None = None
    outcome: str | None = None
    reply: str | None = None
    done_at: str | None = None
    truncated_fields: list[str] = Field(default_factory=list)


class ProjectInboxResult(WireModel):
    status: str = "new"
    messages: list[InboxMessage] = Field(default_factory=list)
    untrusted: bool = False
    next_offset: int | None = None
    truncated: bool = False


class ProjectSessionsResult(WireModel):
    sessions: list[SessionMetadata] = Field(default_factory=list)
    next_offset: int | None = None
    truncated: bool = False


class Capabilities(WireModel):
    requests: list[str] = Field(default_factory=list)
    notifications: list[str] = Field(default_factory=list)
    features: list[str] = Field(default_factory=list)


class HelloResult(WireModel):
    protocol_version: str
    server: str = "zeta"
    capabilities: Capabilities = Field(default_factory=Capabilities)

    def supports(self, request: str) -> bool:
        return request in self.capabilities.requests

    def supports_feature(self, feature: str) -> bool:
        return feature in self.capabilities.features


class ZetaEvent(WireModel):
    """One ``event`` notification: the envelope plus the event's own fields."""

    event: str
    session_id: str | None = None

    @property
    def fields(self) -> dict[str, Any]:
        """Event-specific payload, without the envelope keys."""

        data = self.model_dump(mode="json")
        data.pop("event", None)
        data.pop("session_id", None)
        return data


# --- errors ----------------------------------------------------------------


class ZetaProtocolError(Exception):
    """The peer broke the protocol, or the transport died mid-request."""


class ZetaRpcError(ZetaProtocolError):
    """A JSON-RPC error response."""

    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(f"zeta rpc error {code}: {message}")
        self.code = code
        self.message = message
        self.data = data


class ZetaHandshakeError(ZetaProtocolError):
    """The server is not a zeta serve gamma can drive."""


class FrameTooLargeError(ZetaProtocolError):
    """A frame exceeded the 1 MiB codec limit."""


# --- connection ------------------------------------------------------------

EventHandler = Callable[[ZetaEvent], Awaitable[None] | None]


class ZetaConnection:
    """One client connection to one ``zeta serve`` process.

    The connection owns request/response correlation and pushes every
    notification to ``on_event``. zeta serves one client at a time, so one
    connection equals one live zeta session.
    """

    def __init__(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        *,
        on_event: EventHandler | None = None,
        request_timeout: float = 30.0,
    ) -> None:
        self._reader = reader
        self._writer = writer
        self._on_event = on_event
        self._request_timeout = request_timeout
        self._ids = itertools.count(1)
        self._pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self._write_lock = asyncio.Lock()
        self._reader_task: asyncio.Task[None] | None = None
        self._closed = asyncio.Event()
        self._failure: BaseException | None = None

    @classmethod
    async def connect_unix(
        cls,
        socket_path: str,
        *,
        on_event: EventHandler | None = None,
        request_timeout: float = 30.0,
    ) -> ZetaConnection:
        reader, writer = await asyncio.open_unix_connection(socket_path, limit=MAX_FRAME_BYTES)
        connection = cls(reader, writer, on_event=on_event, request_timeout=request_timeout)
        connection.start()
        return connection

    def start(self) -> None:
        if self._reader_task is None:
            self._reader_task = asyncio.create_task(self._read_loop(), name="zeta-read-loop")

    @property
    def closed(self) -> bool:
        return self._closed.is_set()

    async def hello(self) -> HelloResult:
        """Run the handshake and check that the server can serve gamma.

        Must be the first request on the connection.
        """

        result = await self.call(
            "hello",
            {
                "protocol_version": CLIENT_PROTOCOL_VERSION,
                "client_version": CLIENT_VERSION,
                "features": list(REQUESTED_FEATURES),
            },
        )
        hello = HelloResult.model_validate(result)
        if hello.protocol_version not in ("1.0", "1.1"):
            raise ZetaHandshakeError(
                f"unsupported zeta protocol version {hello.protocol_version!r}"
            )
        missing = sorted(REQUIRED_REQUESTS - set(hello.capabilities.requests))
        if missing:
            raise ZetaHandshakeError(f"zeta server lacks required requests: {', '.join(missing)}")
        return hello

    async def call(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        """Send one request and wait for its response."""

        if self.closed:
            raise ZetaProtocolError("connection is closed") from self._failure
        request_id = next(self._ids)
        frame = (
            json.dumps(
                {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}},
                separators=(",", ":"),
            ).encode()
            + b"\n"
        )
        if len(frame) > MAX_FRAME_BYTES:
            raise FrameTooLargeError(f"{method} request is {len(frame)} bytes (limit is 1 MiB)")
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        try:
            async with self._write_lock:
                self._writer.write(frame)
                await self._writer.drain()
            return await asyncio.wait_for(future, timeout=self._request_timeout)
        except TimeoutError:
            # The request outlived ``request_timeout``. This is a liveness
            # signal, not a dead transport, so callers bound it themselves;
            # keep it distinct from a connection failure. (``TimeoutError`` is
            # an ``OSError`` subclass, so it must be re-raised before the
            # transport-error branch below.)
            raise
        except (OSError, EOFError) as exc:
            # The write side (``write``/``drain``) can raise ``BrokenPipeError``,
            # ``ConnectionResetError``, or another ``OSError`` directly, and the
            # read loop can set a raw transport error (connection reset, EOF
            # mid-frame via ``IncompleteReadError``) on this request's future.
            # Normalize every such mid-request transport death to one protocol
            # error so each caller sees a single type instead of leaking the OS
            # exception past its error handling. ``asyncio.CancelledError`` is a
            # ``BaseException`` and is not caught here, so cancellation still
            # propagates.
            failure = ZetaProtocolError(f"zeta connection failed: {exc}")
            # Drop this request before failing the rest, so ``_finish`` does not
            # set an exception on a future no one will await (this call raises
            # instead), and mark the connection dead so later calls fail fast.
            self._pending.pop(request_id, None)
            self._finish(failure)
            raise failure from exc
        finally:
            self._pending.pop(request_id, None)

    async def aclose(self) -> None:
        """Close the transport and fail every in-flight request."""

        self._fail_pending(ZetaProtocolError("connection closed by gamma"))
        self._closed.set()
        try:
            self._writer.close()
            await self._writer.wait_closed()
        except (OSError, RuntimeError):
            pass
        if self._reader_task is not None:
            self._reader_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._reader_task
            self._reader_task = None

    async def _read_loop(self) -> None:
        try:
            while True:
                try:
                    line = await self._reader.readuntil(b"\n")
                except asyncio.LimitOverrunError as exc:
                    raise FrameTooLargeError("inbound frame exceeds the stream limit") from exc
                if not line:
                    raise ZetaProtocolError("zeta closed the connection")
                await self._dispatch(line)
        except asyncio.IncompleteReadError:
            self._finish(ZetaProtocolError("zeta closed the connection"))
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # transport or protocol failure
            self._finish(exc)

    async def _dispatch(self, line: bytes) -> None:
        try:
            frame = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ZetaProtocolError(f"zeta sent invalid JSON: {exc}") from exc
        if not isinstance(frame, dict):
            raise ZetaProtocolError("zeta sent a non-object frame")
        if frame.get("method") == "event":
            params = frame.get("params") or {}
            if self._on_event is not None and isinstance(params, dict) and params.get("event"):
                result = self._on_event(ZetaEvent.model_validate(params))
                if asyncio.iscoroutine(result):
                    await result
            return
        request_id = frame.get("id")
        future = self._pending.get(request_id) if isinstance(request_id, int) else None
        if future is None or future.done():
            return
        if "error" in frame:
            error = frame["error"] or {}
            future.set_exception(
                ZetaRpcError(
                    int(error.get("code", -32000)),
                    str(error.get("message", "unknown error")),
                    error.get("data"),
                )
            )
            return
        result = frame.get("result")
        future.set_result(result if isinstance(result, dict) else {})

    def _finish(self, exc: BaseException) -> None:
        self._failure = exc
        self._closed.set()
        self._fail_pending(exc)

    def _fail_pending(self, exc: BaseException) -> None:
        for future in list(self._pending.values()):
            if not future.done():
                future.set_exception(exc)
        self._pending.clear()


__all__ = [
    "CLIENT_PROTOCOL_VERSION",
    "CLIENT_VERSION",
    "LIST_SESSIONS_PAGING_FEATURE",
    "MAX_FRAME_BYTES",
    "PROJECTS_FEATURE",
    "REQUESTED_FEATURES",
    "REQUIRED_REQUESTS",
    "Capabilities",
    "ContentBlock",
    "FrameTooLargeError",
    "HelloResult",
    "InboxMessage",
    "MemoryFile",
    "MemoryLogResult",
    "MemorySnapshot",
    "MemoryVersion",
    "MemoryVersionDetail",
    "MemoryVersionResult",
    "Message",
    "PendingApproval",
    "ProjectDetail",
    "ProjectInboxResult",
    "ProjectListResult",
    "ProjectSessionsResult",
    "ProjectShowResult",
    "ProjectSummary",
    "SessionMetadata",
    "StatusResult",
    "ToolCall",
    "ToolResult",
    "ZetaConnection",
    "ZetaEvent",
    "ZetaHandshakeError",
    "ZetaProtocolError",
    "ZetaRpcError",
]
