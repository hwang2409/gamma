"""Run ``zeta serve`` as a child process on this host.

One process per gamma session, on a Unix socket inside a private temporary
directory. The runtime owns the whole life cycle: spawn, wait for the socket,
handshake, then graceful shutdown with a kill fallback. It also keeps a set of
live connections so application shutdown reaps every child.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import shutil
import signal
import tempfile
from collections import deque
from typing import Any

from .runtime import RuntimeConnection, RuntimeLaunchError, RuntimeSpec, ZetaRuntime
from .zeta_protocol import (
    EventHandler,
    HelloResult,
    ZetaConnection,
    ZetaProtocolError,
)

logger = logging.getLogger(__name__)

SOCKET_WAIT_SECONDS = 20.0
SHUTDOWN_GRACE_SECONDS = 5.0


class LocalProcessConnection(RuntimeConnection):
    """A handshaken client plus the child process it drives."""

    def __init__(
        self,
        *,
        process: asyncio.subprocess.Process,
        connection: ZetaConnection,
        hello: HelloResult,
        work_dir: str,
        on_closed: Any = None,
    ) -> None:
        self._process = process
        self._connection = connection
        self._hello = hello
        self._work_dir = work_dir
        self._on_closed = on_closed
        self._closing: asyncio.Lock = asyncio.Lock()
        self._closed = False
        self._stderr_tail: deque[str] = deque(maxlen=50)
        self._stderr_task = asyncio.create_task(self._drain_stderr(), name="zeta-stderr")

    @property
    def stderr_tail(self) -> str:
        """The last lines the child wrote to stderr, for diagnostics."""

        return "".join(self._stderr_tail)

    async def _drain_stderr(self) -> None:
        """Keep reading stderr so a chatty child never blocks on a full pipe."""

        stream = self._process.stderr
        if stream is None:
            return
        with contextlib.suppress(Exception):
            while True:
                line = await stream.readline()
                if not line:
                    return
                self._stderr_tail.append(line.decode("utf-8", "replace"))

    @property
    def hello(self) -> HelloResult:
        return self._hello

    @property
    def pid(self) -> int:
        return self._process.pid

    @property
    def alive(self) -> bool:
        return not self._closed and self._process.returncode is None and not self._connection.closed

    async def call(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        if self._closed:
            raise ZetaProtocolError("runtime connection is closed")
        return await self._connection.call(method, params)

    async def aclose(self) -> None:
        async with self._closing:
            if self._closed:
                return
            self._closed = True
            await self._connection.aclose()
            await self._stop_process()
            self._stderr_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._stderr_task
            shutil.rmtree(self._work_dir, ignore_errors=True)
        if self._on_closed is not None:
            self._on_closed(self)

    async def _stop_process(self) -> None:
        process = self._process
        if process.returncode is not None:
            return
        # zeta serve shuts down cleanly on SIGTERM: it closes clients and
        # turns, closes the listener, and removes the socket.
        with contextlib.suppress(ProcessLookupError):
            process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=SHUTDOWN_GRACE_SECONDS)
            return
        except TimeoutError:
            logger.warning("zeta serve pid %s ignored SIGTERM; killing", process.pid)
        with contextlib.suppress(ProcessLookupError):
            process.kill()
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(process.wait(), timeout=SHUTDOWN_GRACE_SECONDS)


class LocalProcessRuntime(ZetaRuntime):
    """Spawn and supervise local ``zeta serve`` processes."""

    def __init__(
        self,
        *,
        zeta_bin: str = "zeta",
        socket_wait_seconds: float = SOCKET_WAIT_SECONDS,
        request_timeout: float = 30.0,
    ) -> None:
        self._zeta_bin = zeta_bin
        self._socket_wait_seconds = socket_wait_seconds
        self._request_timeout = request_timeout
        self._live: set[LocalProcessConnection] = set()

    @property
    def live_count(self) -> int:
        return len(self._live)

    async def launch(self, spec: RuntimeSpec, on_event: EventHandler) -> RuntimeConnection:
        # A short directory name matters: Unix socket paths are limited to
        # about 104 bytes on macOS and 108 on Linux.
        work_dir = tempfile.mkdtemp(prefix="gz-")
        socket_path = os.path.join(work_dir, "serve.sock")
        try:
            process = await self._spawn(spec, socket_path)
        except OSError as exc:
            shutil.rmtree(work_dir, ignore_errors=True)
            raise RuntimeLaunchError(f"cannot start {self._zeta_bin}: {exc}") from exc
        try:
            connection = await self._connect(socket_path, process, on_event)
        except BaseException:
            await _terminate(process)
            shutil.rmtree(work_dir, ignore_errors=True)
            raise
        try:
            hello = await connection.hello()
        except BaseException as exc:
            await connection.aclose()
            await _terminate(process)
            shutil.rmtree(work_dir, ignore_errors=True)
            if isinstance(exc, ZetaProtocolError):
                raise RuntimeLaunchError(f"zeta handshake failed: {exc}") from exc
            raise
        handle = LocalProcessConnection(
            process=process,
            connection=connection,
            hello=hello,
            work_dir=work_dir,
            on_closed=self._live.discard,
        )
        self._live.add(handle)
        logger.info(
            "zeta serve pid %s ready (provider=%s protocol=%s)",
            process.pid,
            spec.provider,
            hello.protocol_version,
        )
        return handle

    async def aclose(self) -> None:
        for handle in list(self._live):
            with contextlib.suppress(Exception):
                await handle.aclose()
        self._live.clear()

    async def _spawn(self, spec: RuntimeSpec, socket_path: str) -> asyncio.subprocess.Process:
        argv = [self._zeta_bin, "serve", "--socket", socket_path, "--provider", spec.provider]
        if spec.model:
            argv += ["--model", spec.model]
        if spec.cwd:
            argv += ["--cwd", spec.cwd]
        if spec.tools:
            argv += ["--tools", spec.tools]
        if spec.disallowed_tools:
            argv += ["--disallowed-tools", spec.disallowed_tools]
        if spec.require_tools:
            argv.append("--require-tools")
        env = {**os.environ, **spec.env}
        return await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
            cwd=spec.cwd or None,
            env=env,
            start_new_session=True,
        )

    async def _connect(
        self,
        socket_path: str,
        process: asyncio.subprocess.Process,
        on_event: EventHandler,
    ) -> ZetaConnection:
        """Retry the connect until zeta listens, the child dies, or time runs out.

        Retrying the connect (instead of watching for the socket file) also
        avoids the gap between ``bind`` and ``listen``.
        """

        deadline = asyncio.get_running_loop().time() + self._socket_wait_seconds
        while True:
            try:
                return await ZetaConnection.connect_unix(
                    socket_path, on_event=on_event, request_timeout=self._request_timeout
                )
            except (FileNotFoundError, ConnectionRefusedError, OSError) as exc:
                last_error: OSError = exc
            if process.returncode is not None:
                detail = await _read_stderr(process)
                raise RuntimeLaunchError(
                    f"zeta serve exited with code {process.returncode} before listening: {detail}"
                )
            if asyncio.get_running_loop().time() >= deadline:
                raise RuntimeLaunchError(
                    f"zeta serve did not accept a client on {socket_path} within "
                    f"{self._socket_wait_seconds:g}s: {last_error}"
                )
            await asyncio.sleep(0.05)


async def _read_stderr(process: asyncio.subprocess.Process, limit: int = 2000) -> str:
    if process.stderr is None:
        return ""
    with contextlib.suppress(Exception):
        data = await asyncio.wait_for(process.stderr.read(limit), timeout=1.0)
        return data.decode("utf-8", "replace").strip()
    return ""


async def _terminate(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        return
    with contextlib.suppress(ProcessLookupError):
        process.send_signal(signal.SIGTERM)
    try:
        await asyncio.wait_for(process.wait(), timeout=SHUTDOWN_GRACE_SECONDS)
    except TimeoutError:
        with contextlib.suppress(ProcessLookupError):
            process.kill()
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(process.wait(), timeout=SHUTDOWN_GRACE_SECONDS)


__all__ = ["LocalProcessConnection", "LocalProcessRuntime"]
