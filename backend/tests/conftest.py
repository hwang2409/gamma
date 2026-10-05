"""Shared fixtures.

Every test that touches a real harness uses ``zeta serve --provider fake``,
which needs no API keys, and a private ``ZETA_HOME`` so test sessions never
mix with the developer's own sessions.
"""

from __future__ import annotations

import shutil
from collections.abc import Iterator
from pathlib import Path

import pytest

from gamma.config import Settings
from gamma.local_runtime import LocalProcessRuntime

ZETA_BIN = shutil.which("zeta")

requires_zeta = pytest.mark.skipif(ZETA_BIN is None, reason="the zeta CLI is not installed")


@pytest.fixture
def zeta_home(tmp_path: Path) -> Path:
    home = tmp_path / "zeta-home"
    home.mkdir()
    return home


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    """An allowed root that also works as a session cwd."""

    root = tmp_path / "workspace"
    (root / "project").mkdir(parents=True)
    return root


@pytest.fixture
def settings(workspace: Path, zeta_home: Path) -> Settings:
    return Settings(
        access_token="test-token",
        allowed_origins=["http://localhost:5173"],
        allowed_providers=["fake"],
        allowed_models={"fake": ["offline", "faster"]},
        allowed_roots=[workspace],
        zeta_bin=ZETA_BIN or "zeta",
        zeta_env={"ZETA_HOME": str(zeta_home)},
        session_idle_timeout_seconds=3600.0,
        request_timeout_seconds=30.0,
        event_buffer_capacity=50,
    )


@pytest.fixture
async def local_runtime(settings: Settings) -> Iterator[LocalProcessRuntime]:
    runtime = LocalProcessRuntime(zeta_bin=settings.zeta_bin)
    try:
        yield runtime
    finally:
        await runtime.aclose()
