"""The gamma HTTP and WebSocket API.

REST manages sessions. One WebSocket per session carries events out and
commands in. Any number of sockets may attach to the same session; each one
replays from its own cursor.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated, Any

from fastapi import Cookie, Depends, FastAPI, Header, HTTPException, Query, Request, WebSocket
from pydantic import ValidationError
from starlette.websockets import WebSocketDisconnect

from .api_models import (
    AbortCommand,
    AckFrame,
    AuthCommand,
    ClientFrame,
    DecisionCommand,
    ErrorFrame,
    EventFrame,
    OptionsResponse,
    PingCommand,
    PongFrame,
    ProviderOption,
    SendCommand,
    SessionCreateRequest,
    SessionList,
    SessionView,
    SnapshotFrame,
    SteerCommand,
    ZetaSessionList,
    ZetaSessionSummary,
)
from .config import Settings, get_settings
from .local_runtime import LocalProcessRuntime
from .policy import PolicyError
from .runtime import RuntimeLaunchError, ZetaRuntime
from .security import (
    TOKEN_COOKIE,
    TOKEN_HEADER,
    AccessControl,
    OriginRejected,
    TokenInvalid,
    TokenMissing,
    generate_token,
)
from .session import GammaSession, SessionError, SessionManager, SessionNotFound
from .zeta_protocol import ZetaProtocolError, ZetaRpcError

logger = logging.getLogger(__name__)

WS_CLOSE_UNAUTHORIZED = 4401
WS_CLOSE_FORBIDDEN = 4403
WS_CLOSE_NOT_FOUND = 4404
WS_CLOSE_SESSION_GONE = 4410


def create_app(
    *,
    settings: Settings | None = None,
    runtime: ZetaRuntime | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    access = AccessControl(settings.access_token or generate_token(), settings.allowed_origins)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.manager.start()
        try:
            yield
        finally:
            # Reap every zeta serve child, even on an unclean shutdown.
            await app.state.manager.aclose()

    app = FastAPI(title="gamma", version="0.1.0", lifespan=lifespan)
    app.state.settings = settings
    app.state.access = access
    app.state.runtime = runtime or LocalProcessRuntime(
        zeta_bin=settings.zeta_bin, request_timeout=settings.request_timeout_seconds
    )
    app.state.manager = SessionManager(runtime=app.state.runtime, settings=settings)

    def require_auth(
        request: Request,
        x_gamma_token: Annotated[str | None, Header(alias=TOKEN_HEADER)] = None,
        gamma_token: Annotated[str | None, Cookie(alias=TOKEN_COOKIE)] = None,
    ) -> None:
        origin = request.headers.get("origin")
        try:
            # A cookie-only caller may be a hostile page, so its Origin must
            # be one gamma serves. Header callers are not browsers.
            access.check_origin(origin, required=False)
            access.check_token(x_gamma_token or gamma_token)
        except TokenMissing as exc:
            raise HTTPException(status_code=401, detail=str(exc)) from exc
        except (TokenInvalid, OriginRejected) as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc

    auth = [Depends(require_auth)]

    def manager() -> SessionManager:
        return app.state.manager

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/options", dependencies=auth, response_model=OptionsResponse)
    async def options() -> OptionsResponse:
        providers = [
            ProviderOption(name=name, models=settings.models_for(name))
            for name in settings.allowed_providers
        ]
        try:
            directories = manager().policy.list_directories()
        except (PolicyError, OSError):
            directories = []
        return OptionsResponse(
            providers=providers,
            default_provider=settings.allowed_providers[0] if settings.allowed_providers else None,
            allowed_roots=[str(root) for root in settings.allowed_roots],
            directories=directories,
        )

    @app.get("/api/zeta-sessions", dependencies=auth, response_model=ZetaSessionList)
    async def zeta_sessions(provider: Annotated[str, Query()]) -> ZetaSessionList:
        try:
            sessions = await manager().list_zeta_sessions(provider)
        except PolicyError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except (RuntimeLaunchError, ZetaProtocolError) as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        return ZetaSessionList(
            sessions=[ZetaSessionSummary.from_metadata(item) for item in sessions]
        )

    @app.get("/api/sessions", dependencies=auth, response_model=SessionList)
    async def list_sessions() -> SessionList:
        return SessionList(
            sessions=[SessionView.from_snapshot(session.snapshot()) for session in manager().list()]
        )

    @app.post("/api/sessions", dependencies=auth, response_model=SessionView, status_code=201)
    async def create_session(body: SessionCreateRequest) -> SessionView:
        try:
            session = await manager().create(
                provider=body.provider,
                model=body.model,
                cwd=body.cwd,
                resume_session_id=body.resume_session_id,
            )
        except PolicyError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except SessionError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except (RuntimeLaunchError, ZetaProtocolError) as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        return SessionView.from_snapshot(session.snapshot())

    @app.get("/api/sessions/{session_id}", dependencies=auth, response_model=SessionView)
    async def session_status(session_id: str) -> SessionView:
        session = _lookup(manager(), session_id)
        with contextlib.suppress(SessionError, ZetaProtocolError, ZetaRpcError):
            await session.status()
        return SessionView.from_snapshot(session.snapshot())

    @app.delete("/api/sessions/{session_id}", dependencies=auth, status_code=204)
    async def close_session(session_id: str) -> None:
        try:
            await manager().close(session_id)
        except SessionNotFound as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.websocket("/api/sessions/{session_id}/ws")
    async def session_socket(
        websocket: WebSocket,
        session_id: str,
        cursor: Annotated[int, Query(ge=0)] = 0,
        token: Annotated[str | None, Query()] = None,
    ) -> None:
        await _serve_socket(
            websocket,
            access=access,
            manager=manager(),
            session_id=session_id,
            cursor=cursor,
            query_token=token,
        )

    return app


def _lookup(manager: SessionManager, session_id: str) -> GammaSession:
    try:
        return manager.get(session_id)
    except SessionNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


async def _serve_socket(
    websocket: WebSocket,
    *,
    access: AccessControl,
    manager: SessionManager,
    session_id: str,
    cursor: int,
    query_token: str | None,
) -> None:
    origin = websocket.headers.get("origin")
    try:
        access.check_origin(origin, required=True)
    except OriginRejected:
        await websocket.close(code=WS_CLOSE_FORBIDDEN, reason="origin is not allowed")
        return
    await websocket.accept()
    try:
        presented = query_token or await _read_auth_token(websocket)
        access.check_token(presented)
    except TokenMissing:
        await websocket.close(code=WS_CLOSE_UNAUTHORIZED, reason="missing token")
        return
    except (TokenInvalid, ValidationError, ValueError):
        await websocket.close(code=WS_CLOSE_FORBIDDEN, reason="invalid token")
        return
    except WebSocketDisconnect:
        return

    try:
        session = manager.get(session_id)
    except SessionNotFound:
        await websocket.close(code=WS_CLOSE_NOT_FOUND, reason="unknown session")
        return

    session.touch()
    snapshot = session.snapshot()
    await websocket.send_text(
        SnapshotFrame(
            session=SessionView.from_snapshot(snapshot), replay_from=cursor
        ).model_dump_json()
    )
    pump = asyncio.create_task(_pump_events(websocket, session, cursor), name="gamma-ws-events")
    try:
        await _read_commands(websocket, session)
    finally:
        pump.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await pump


async def _read_auth_token(websocket: WebSocket) -> str | None:
    """Read the first frame, which must be an ``auth`` command."""

    raw = await websocket.receive_text()
    frame = ClientFrame.model_validate({"command": _json_loads(raw)})
    if not isinstance(frame.command, AuthCommand):
        raise TokenMissing("first message must be auth")
    return frame.command.token


async def _pump_events(websocket: WebSocket, session: GammaSession, cursor: int) -> None:
    """Replay from ``cursor``, then stream live events to this socket."""

    try:
        async for event in session.bus.subscribe(after_cursor=cursor):
            await websocket.send_text(
                EventFrame(
                    cursor=event.cursor, event=event.event, payload=event.payload
                ).model_dump_json()
            )
    except (WebSocketDisconnect, RuntimeError):
        return
    with contextlib.suppress(RuntimeError, WebSocketDisconnect):
        await websocket.close(code=WS_CLOSE_SESSION_GONE, reason="session closed")


async def _read_commands(websocket: WebSocket, session: GammaSession) -> None:
    while True:
        try:
            raw = await websocket.receive_text()
        except WebSocketDisconnect:
            return
        try:
            command = ClientFrame.model_validate({"command": _json_loads(raw)}).command
        except (ValidationError, ValueError) as exc:
            await _send_error(websocket, f"invalid command: {_first_error(exc)}")
            continue
        await _run_command(websocket, session, command)


async def _run_command(websocket: WebSocket, session: GammaSession, command: Any) -> None:
    if isinstance(command, PingCommand):
        await websocket.send_text(PongFrame().model_dump_json())
        return
    if isinstance(command, AuthCommand):
        return  # already authenticated; ignore repeats
    try:
        match command:
            case SendCommand():
                result = await session.send(command.text)
            case SteerCommand():
                result = await session.steer(command.text)
            case AbortCommand():
                result = await session.abort()
            case DecisionCommand():
                result = await session.decide(
                    request_id=command.request_id,
                    approve=command.type == "approve",
                    scope=command.scope,
                )
            case _:
                await _send_error(websocket, "unsupported command")
                return
    except ZetaRpcError as exc:
        await _send_error(websocket, exc.message, command=command.type)
        return
    except (SessionError, ZetaProtocolError, TimeoutError) as exc:
        await _send_error(websocket, str(exc), command=command.type)
        return
    await websocket.send_text(AckFrame(command=command.type, result=result).model_dump_json())


async def _send_error(websocket: WebSocket, message: str, command: str | None = None) -> None:
    with contextlib.suppress(RuntimeError, WebSocketDisconnect):
        await websocket.send_text(ErrorFrame(message=message, command=command).model_dump_json())


def _json_loads(raw: str) -> Any:
    return json.loads(raw)


def _first_error(exc: Exception) -> str:
    if isinstance(exc, ValidationError) and exc.errors():
        first = exc.errors()[0]
        return f"{'.'.join(str(part) for part in first['loc'])}: {first['msg']}"
    return str(exc)


__all__ = ["create_app"]
