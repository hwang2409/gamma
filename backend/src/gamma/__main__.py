"""Run the gamma backend.

The access token is printed once, here, and never logged again. Copy it into
the web UI (the dev server reads it from ``VITE_GAMMA_TOKEN`` or you paste it
on the start page).
"""

from __future__ import annotations

import logging

import uvicorn

from .app import create_app
from .config import get_settings
from .security import generate_token


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    settings = get_settings()
    token = settings.access_token or generate_token()
    settings = settings.model_copy(update={"access_token": token})
    app = create_app(settings=settings)
    banner = (
        f"\ngamma backend on http://{settings.host}:{settings.port}\n"
        f"access token: {token}\n"
        f"allowed origins: {', '.join(settings.allowed_origins)}\n"
        f"allowed roots: {', '.join(str(root) for root in settings.allowed_roots)}\n"
    )
    print(banner, flush=True)  # noqa: T201 - the token is shown once, on purpose
    uvicorn.run(app, host=settings.host, port=settings.port, log_level="info")


if __name__ == "__main__":
    main()
