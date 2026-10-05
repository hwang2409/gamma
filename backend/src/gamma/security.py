"""Access control for v0: one random token plus an Origin allowlist.

Gamma binds to 127.0.0.1, so the threat model is other local software and a
hostile web page in the user's browser. The token stops unauthenticated local
callers; the Origin check stops a page on another site from opening the
WebSocket or riding the cookie. Tokens are never logged.
"""

from __future__ import annotations

import secrets

TOKEN_HEADER = "x-gamma-token"
TOKEN_COOKIE = "gamma_token"
TOKEN_QUERY = "token"


def generate_token() -> str:
    return secrets.token_urlsafe(32)


class TokenMissing(Exception):
    """No credential was presented (HTTP 401)."""


class TokenInvalid(Exception):
    """A credential was presented but does not match (HTTP 403)."""


class OriginRejected(Exception):
    """The request came from an Origin gamma does not serve (HTTP 403)."""


class AccessControl:
    """Checks credentials and origins for both REST and WebSocket entry."""

    def __init__(self, token: str, allowed_origins: list[str]) -> None:
        self._token = token
        self._allowed_origins = {origin.rstrip("/") for origin in allowed_origins}

    @property
    def token(self) -> str:
        return self._token

    def check_token(self, presented: str | None) -> None:
        if presented is None or presented == "":
            raise TokenMissing("missing gamma access token")
        if not secrets.compare_digest(presented, self._token):
            raise TokenInvalid("invalid gamma access token")

    def check_origin(self, origin: str | None, *, required: bool) -> None:
        """Check a browser Origin.

        ``required=True`` (WebSocket) rejects a missing Origin as well, because
        every browser sends one. ``required=False`` (REST) allows non-browser
        callers that send no Origin at all but still hold the token.
        """

        if origin is None:
            if required:
                raise OriginRejected("missing Origin header")
            return
        if origin.rstrip("/") not in self._allowed_origins:
            raise OriginRejected("origin is not allowed")


__all__ = [
    "TOKEN_COOKIE",
    "TOKEN_HEADER",
    "TOKEN_QUERY",
    "AccessControl",
    "OriginRejected",
    "TokenInvalid",
    "TokenMissing",
    "generate_token",
]
