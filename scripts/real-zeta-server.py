"""Run the pinned Zeta server with only its provider backend replaced by a script."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

from tests.support.fake_backend import FakeBackend, ScriptedTurn
from zeta.protocol.types import TextContent, ToolCall
from zeta.server.server import ZetaServer
from zeta.storage_format import advance


def make_server() -> tuple[ZetaServer, Path]:
    home = Path(os.environ["ZETA_HOME"])
    cwd = Path(os.environ["ZETA_PROOF_CWD"])
    control = Path(os.environ["ZETA_PROOF_CONTROL"])
    home.mkdir(parents=True, exist_ok=True)
    advance(home, expected_epoch=0)
    backend = FakeBackend(
        [
            ScriptedTurn(
                content=[TextContent("\n".join(f"proof context line {index}" for index in range(1, 81)))],
                tool_calls=[ToolCall("proof-call", "bash", {"command": "printf real-zeta-proof"})],
            ),
            ScriptedTurn(content=[TextContent("real zeta proof complete")]),
        ]
    )
    return (
        ZetaServer(
            home=home,
            cwd=cwd,
            ws_port=0,
            ws_origins=(os.environ["ZETA_PROOF_ORIGIN"],),
            provider="codex",
            auto_memory=False,
            backend_factory=lambda provider, model, selected_home: (backend, model or "offline"),
        ),
        control,
    )


async def main(server: ZetaServer, control: Path) -> None:
    await server.start()
    websocket = server._websocket
    assert websocket is not None and websocket.controller_token is not None
    control.write_text(json.dumps({"port": websocket.port, "token": websocket.controller_token}), encoding="utf-8")
    control.chmod(0o600)
    try:
        await server.serve_forever()
    finally:
        await server.close()


if __name__ == "__main__":
    proof_server, proof_control = make_server()
    asyncio.run(main(proof_server, proof_control))
