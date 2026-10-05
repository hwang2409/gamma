"""The seam between gamma and wherever a zeta harness runs.

``zeta serve`` accepts one client and holds one active session, so gamma runs
one zeta process per gamma session. :class:`ZetaRuntime` hides *where* that
process lives: :class:`~gamma.local_runtime.LocalProcessRuntime` spawns it on
this host, and a later remote runtime (a sandbox, another machine) implements
the same two methods without the rest of gamma changing.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass, field
from typing import Any

from .zeta_protocol import EventHandler, HelloResult


@dataclass(frozen=True, slots=True)
class RuntimeSpec:
    """How to launch one zeta harness.

    ``cwd`` and ``tools``/``disallowed_tools`` are process-launch options
    because zeta serve takes them on the command line, not over the wire.
    """

    provider: str
    model: str | None = None
    cwd: str | None = None
    tools: str | None = None
    disallowed_tools: str | None = None
    require_tools: bool = False
    env: dict[str, str] = field(default_factory=dict)


class RuntimeConnection(abc.ABC):
    """A handshaken client of one zeta harness."""

    @property
    @abc.abstractmethod
    def hello(self) -> HelloResult:
        """The handshake result; use it to gate optional (1.1) requests."""

    @property
    @abc.abstractmethod
    def alive(self) -> bool:
        """False once the harness or its transport is gone."""

    @abc.abstractmethod
    async def call(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        """Send one zeta request and return its result."""

    @abc.abstractmethod
    async def aclose(self) -> None:
        """Close the client, stop the harness, and release its resources."""

    def supports(self, request: str) -> bool:
        return self.hello.supports(request)


class ZetaRuntime(abc.ABC):
    """Factory for harness connections."""

    @abc.abstractmethod
    async def launch(self, spec: RuntimeSpec, on_event: EventHandler) -> RuntimeConnection:
        """Start a harness for ``spec`` and return a handshaken connection."""

    @abc.abstractmethod
    async def aclose(self) -> None:
        """Release every harness this runtime still owns."""


class RuntimeLaunchError(RuntimeError):
    """The harness did not start, or refused the handshake."""


__all__ = [
    "RuntimeConnection",
    "RuntimeLaunchError",
    "RuntimeSpec",
    "ZetaRuntime",
]
