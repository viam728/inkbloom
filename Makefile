.PHONY: up up-infra down build logs dev dev-server dev-web dev-ai migrate-up migrate-down test lint clean proto

# ── Docker Compose (Full Stack) ──────────────────────────────────────────
up:
	docker compose up -d --build

up-infra:
	docker compose up -d postgres redis nats

down:
	docker compose down

build:
	docker compose build

logs:
	docker compose logs -f

# ── Development Mode (Docker) ────────────────────────────────────────────
dev:
	docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build

# ── Local Development (without Docker for app services) ──────────────────
dev-server:
	cd packages/server && air

dev-web:
	pnpm --filter web dev

dev-ai:
	cd packages/ai-service && uvicorn app.main:app --reload --host 0.0.0.0 --port 8100

# ── Database ─────────────────────────────────────────────────────────────
migrate-up:
	cd packages/server && migrate -path migrations -database "$(DATABASE_URL)" up

migrate-down:
	cd packages/server && migrate -path migrations -database "$(DATABASE_URL)" down

# ── Build (local) ────────────────────────────────────────────────────────
build-local:
	pnpm -r build
	cd packages/server && go build -o bin/server ./cmd/server

# ── Test ─────────────────────────────────────────────────────────────────
test:
	pnpm -r test
	cd packages/server && go test ./...

# ── Lint ─────────────────────────────────────────────────────────────────
lint:
	pnpm -r lint
	cd packages/server && golangci-lint run

# ── Clean ────────────────────────────────────────────────────────────────
clean:
	rm -rf packages/server/bin
	rm -rf packages/web/dist
	rm -rf packages/ai-service/__pycache__
	find . -name "node_modules" -type d -prune -exec rm -rf '{}' +

# ── Proto ────────────────────────────────────────────────────────────────
proto:
	cd packages/shared && buf generate
