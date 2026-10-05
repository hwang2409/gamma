BACKEND := backend
WEB := web

.PHONY: help dev backend web test test-backend test-web lint smoke build install clean

help:
	@echo "make install       install backend and web dependencies"
	@echo "make dev           run the backend and the web dev server together"
	@echo "make backend       run the backend only (prints an access token)"
	@echo "make web           run the web dev server only"
	@echo "make test          every test, plus lint, typecheck, and build"
	@echo "make smoke         end-to-end check against zeta serve --provider fake"

install:
	cd $(BACKEND) && uv sync --all-groups
	cd $(WEB) && pnpm install

dev:
	@echo "backend on http://127.0.0.1:8777, web on http://localhost:5173"
	@trap 'kill 0' EXIT INT TERM; \
	( cd $(BACKEND) && uv run python -m gamma ) & \
	( cd $(WEB) && pnpm dev ) & \
	wait

backend:
	cd $(BACKEND) && uv run python -m gamma

web:
	cd $(WEB) && pnpm dev

test: test-backend test-web

test-backend:
	cd $(BACKEND) && uv run ruff check . && uv run ruff format --check . && uv run pytest -q

test-web:
	cd $(WEB) && pnpm lint && pnpm test && pnpm build

build:
	cd $(WEB) && pnpm build

smoke:
	uv run --project $(BACKEND) python scripts/smoke_e2e.py

clean:
	rm -rf $(WEB)/dist $(BACKEND)/.pytest_cache $(BACKEND)/.ruff_cache
