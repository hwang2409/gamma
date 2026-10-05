"""Server-side configuration.

Everything the browser must not choose lives here: which zeta binary runs,
which providers and models are allowed, which directories a session may open,
and the tool policy passed to ``zeta serve``.
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Annotated

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

DEFAULT_MODELS: dict[str, list[str]] = {
    "fake": ["offline", "faster"],
    "claude": [
        "claude-sonnet-5",
        "claude-opus-5-5",
        "claude-opus-5",
        "claude-sonnet-4-6",
        "claude-opus-4-6",
        "claude-haiku-4-5",
    ],
    "codex": ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.4-mini"],
}


class Settings(BaseSettings):
    """Gamma backend settings, read from ``GAMMA_*`` environment variables."""

    model_config = SettingsConfigDict(env_prefix="GAMMA_", env_file=".env", extra="ignore")

    # transport
    host: str = "127.0.0.1"
    port: int = 8777
    allowed_origins: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["http://localhost:5173"]
    )

    # auth: a random token is generated at startup when this is unset
    access_token: str | None = None

    # zeta harness
    zeta_bin: str = "zeta"
    allowed_providers: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["fake", "claude", "codex"]
    )
    allowed_models: dict[str, list[str]] = Field(default_factory=lambda: dict(DEFAULT_MODELS))
    allowed_roots: Annotated[list[Path], NoDecode] = Field(
        default_factory=lambda: [Path.home() / "me" / "fun"]
    )

    # extra environment for every zeta serve child (for example ZETA_HOME)
    zeta_env: dict[str, str] = Field(default_factory=dict)
    # Claude subscription logins need Zeta's Anthropic OAuth compatibility mode.
    # It is on by default so Claude works regardless of the launching shell.
    anthropic_oauth_compat: bool = True

    # tool policy is server-side only in v0; the browser cannot change it
    tools: str | None = None
    disallowed_tools: str | None = None
    require_tools: bool = False

    # lifecycle
    session_idle_timeout_seconds: float = 3600.0
    max_sessions: int = 8
    event_buffer_capacity: int = 1000
    request_timeout_seconds: float = 30.0

    @field_validator("allowed_origins", "allowed_providers", mode="before")
    @classmethod
    def _split_list(cls, value: object) -> object:
        """Accept a comma-separated environment value or a real list."""

        if isinstance(value, str):
            return [item.strip() for item in value.split(",") if item.strip()]
        return value

    @field_validator("allowed_roots", mode="before")
    @classmethod
    def _split_paths(cls, value: object) -> object:
        """Accept a ``PATH``-style environment value or a real list."""

        if isinstance(value, str):
            return [item.strip() for item in value.split(os.pathsep) if item.strip()]
        return value

    @field_validator("allowed_roots")
    @classmethod
    def _resolve_roots(cls, value: list[Path]) -> list[Path]:
        return [path.expanduser().resolve() for path in value]

    def models_for(self, provider: str) -> list[str]:
        return list(self.allowed_models.get(provider, []))

    def default_model(self, provider: str) -> str | None:
        models = self.models_for(provider)
        return models[0] if models else None


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


__all__ = ["DEFAULT_MODELS", "Settings", "get_settings"]
