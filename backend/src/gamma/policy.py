"""What the browser may ask gamma to launch.

The browser sends a provider, an optional model, and a working directory.
Nothing else reaches the ``zeta serve`` command line: tool allowlists and the
approval policy come from server settings. This module turns a browser request
into a :class:`~gamma.runtime.RuntimeSpec`, or refuses it.
"""

from __future__ import annotations

from pathlib import Path

from .config import Settings
from .runtime import RuntimeSpec


class PolicyError(ValueError):
    """The requested launch is outside the server's policy."""


class LaunchPolicy:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def resolve(self, *, provider: str, model: str | None, cwd: str | None) -> RuntimeSpec:
        settings = self._settings
        if provider not in settings.allowed_providers:
            raise PolicyError(f"provider {provider!r} is not allowed")
        allowed_models = settings.models_for(provider)
        if model is None:
            model = settings.default_model(provider)
        elif model not in allowed_models:
            raise PolicyError(f"model {model!r} is not allowed for provider {provider!r}")
        resolved_cwd = self.resolve_cwd(cwd) if cwd is not None else self.default_cwd()
        return RuntimeSpec(
            provider=provider,
            model=model,
            cwd=str(resolved_cwd),
            tools=settings.tools,
            disallowed_tools=settings.disallowed_tools,
            require_tools=settings.require_tools,
            env=dict(settings.zeta_env),
        )

    def resolve_cwd(self, cwd: str) -> Path:
        """Resolve a browser-supplied directory inside an allowed root.

        Resolution happens before the root check, so symlinks and ``..`` cannot
        escape.
        """

        candidate = Path(cwd).expanduser()
        if not candidate.is_absolute():
            raise PolicyError("cwd must be an absolute path")
        resolved = candidate.resolve()
        if not resolved.is_dir():
            raise PolicyError("cwd must be an existing directory")
        if not self._within_roots(resolved):
            raise PolicyError("cwd is outside the allowed roots")
        return resolved

    def default_cwd(self) -> Path:
        for root in self._settings.allowed_roots:
            if root.is_dir():
                return root
        raise PolicyError("no allowed root exists on this host")

    def list_directories(self, root: Path | None = None) -> list[str]:
        """Immediate sub-directories of the allowed roots, for the cwd picker."""

        roots = [self.resolve_cwd(str(root))] if root is not None else self._existing_roots()
        found: list[str] = []
        for base in roots:
            found.append(str(base))
            for child in sorted(base.iterdir()):
                if child.is_dir() and not child.name.startswith("."):
                    found.append(str(child))
        return found

    def _existing_roots(self) -> list[Path]:
        return [root for root in self._settings.allowed_roots if root.is_dir()]

    def _within_roots(self, resolved: Path) -> bool:
        return any(resolved == root or root in resolved.parents for root in self._existing_roots())


__all__ = ["LaunchPolicy", "PolicyError"]
