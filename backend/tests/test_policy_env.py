from __future__ import annotations

from pathlib import Path

from gamma.config import Settings
from gamma.policy import LaunchPolicy


def _settings(tmp_path: Path, **overrides: object) -> Settings:
    return Settings(allowed_roots=[tmp_path], **overrides)  # type: ignore[arg-type]


def test_claude_sessions_enable_anthropic_oauth_compat_by_default(tmp_path: Path) -> None:
    spec = LaunchPolicy(_settings(tmp_path)).resolve(
        provider="claude", model="claude-opus-5-5", cwd=str(tmp_path)
    )
    assert spec.env["ZETA_ANTHROPIC_OAUTH_COMPAT"] == "1"


def test_anthropic_oauth_compat_can_be_disabled(tmp_path: Path) -> None:
    spec = LaunchPolicy(_settings(tmp_path, anthropic_oauth_compat=False)).resolve(
        provider="codex", model=None, cwd=str(tmp_path)
    )
    assert "ZETA_ANTHROPIC_OAUTH_COMPAT" not in spec.env


def test_explicit_zeta_env_wins_over_the_default(tmp_path: Path) -> None:
    spec = LaunchPolicy(
        _settings(tmp_path, zeta_env={"ZETA_ANTHROPIC_OAUTH_COMPAT": "0", "ZETA_HOME": "/x"})
    ).resolve(provider="codex", model=None, cwd=str(tmp_path))
    assert spec.env == {"ZETA_ANTHROPIC_OAUTH_COMPAT": "0", "ZETA_HOME": "/x"}
