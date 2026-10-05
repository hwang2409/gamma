#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["httpx>=0.27", "websockets>=13.0"]
# ///
"""End-to-end smoke test for gamma.

It starts the real backend, creates a session on a real
``zeta serve --provider fake`` harness, attaches a WebSocket, sends a message,
and checks that the assistant message arrives. It needs no API keys.

    uv run scripts/smoke_e2e.py
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import shutil
import socket
import sys
import tempfile
from pathlib import Path

import httpx
import websockets

TOKEN = "smoke-token"
ORIGIN = "http://localhost:5173"
REPO_ROOT = Path(__file__).resolve().parent.parent


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


async def wait_for_health(base: str, process: asyncio.subprocess.Process) -> None:
    async with httpx.AsyncClient() as client:
        for _ in range(200):
            if process.returncode is not None:
                raise SystemExit(f"the backend exited with code {process.returncode}")
            with contextlib.suppress(httpx.HTTPError):
                if (await client.get(f"{base}/api/health")).status_code == 200:
                    return
            await asyncio.sleep(0.1)
    raise SystemExit("the backend did not become healthy")


async def main() -> int:
    if shutil.which("zeta") is None:
        raise SystemExit("the zeta CLI is not on PATH")

    work = Path(tempfile.mkdtemp(prefix="gamma-smoke-"))
    (work / "project").mkdir()
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    env = {
        **os.environ,
        "GAMMA_ACCESS_TOKEN": TOKEN,
        "GAMMA_PORT": str(port),
        "GAMMA_ALLOWED_PROVIDERS": "fake",
        "GAMMA_ALLOWED_ROOTS": str(work),
        "GAMMA_ALLOWED_ORIGINS": ORIGIN,
        "GAMMA_ZETA_ENV": json.dumps({"ZETA_HOME": str(work / "zeta-home")}),
    }
    process = await asyncio.create_subprocess_exec(
        "uv",
        "run",
        "--project",
        str(REPO_ROOT / "backend"),
        "python",
        "-m",
        "gamma",
        cwd=str(REPO_ROOT),
        env=env,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        await wait_for_health(base, process)
        print(f"backend healthy on {base}")

        headers = {"X-Gamma-Token": TOKEN}
        async with httpx.AsyncClient(headers=headers, timeout=60) as client:
            unauthorized = await client.get(f"{base}/api/sessions", headers={"X-Gamma-Token": ""})
            assert unauthorized.status_code == 401, unauthorized.status_code
            print("REST without a token: 401")

            created = await client.post(
                f"{base}/api/sessions",
                json={"provider": "fake", "model": "offline", "cwd": str(work / "project")},
            )
            created.raise_for_status()
            session = created.json()
            print(
                f"session {session['session_id']} -> zeta {session['zeta_session_id']} "
                f"(protocol {session['protocol_version']})"
            )

            ws_url = f"ws://127.0.0.1:{port}/api/sessions/{session['session_id']}/ws?cursor=0"
            async with websockets.connect(ws_url, origin=ORIGIN) as socket_client:
                await socket_client.send(json.dumps({"type": "auth", "token": TOKEN}))
                snapshot = json.loads(await socket_client.recv())
                assert snapshot["type"] == "snapshot", snapshot
                print(f"snapshot: state={snapshot['session']['state']}")

                await socket_client.send(json.dumps({"type": "send", "text": "hello"}))
                answer = None
                deadline = asyncio.get_running_loop().time() + 60
                while asyncio.get_running_loop().time() < deadline:
                    frame = json.loads(
                        await asyncio.wait_for(socket_client.recv(), timeout=30)
                    )
                    if frame.get("event") == "assistant_message":
                        answer = frame["payload"]["message"]["content"][0]["text"]
                        break
                assert answer == "you said: hello", answer
                print(f"assistant_message: {answer!r}")

            closed = await client.delete(f"{base}/api/sessions/{session['session_id']}")
            assert closed.status_code == 204, closed.status_code
            assert (await client.get(f"{base}/api/sessions")).json()["sessions"] == []
            print("session closed and the harness reaped")
        print("SMOKE OK")
        return 0
    finally:
        with contextlib.suppress(ProcessLookupError):
            process.terminate()
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(process.wait(), timeout=10)
        if process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                process.kill()
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
