# Tutor Platform — backend

Backend MVP: REST API (NestJS on Fastify), four Telegram bots (grammY) and background workers (BullMQ), all from one codebase.
Product requirements live in `../PRODUCT-SPEC.md`, the work plan in `../WORK-PLAN.md`, start-up decisions in `docs/DECISIONS.md`.

## Layout

```text
apps/
  api/          # REST + Telegram webhooks (polling in dev)
  worker/       # queues and schedulers (outbox publisher, notifications, expirations, series, lesson lifecycle)
libs/
  shared/       # config, db, redis, s3, logging, errors, ids, time, http envelope
  modules/      # identity, access, people, schedule, files, content, homework, gradebook, integrations (ICS, Google Calendar), audit, notifications
  telegram/     # auth-bot, staff-bot, student-bot, parent-bot, shared UI, i18n
migrations/     # hand-written SQL migrations applied in order by `pnpm migrate`
scripts/        # CLI: migrate, seed:superadmin, ...
test/           # Testcontainers bootstrap and factories for integration tests
docs/           # decisions and progress
```

Path aliases: `@shared/*`, `@modules/*`, `@telegram/*`, `@test/*` (see `tsconfig.json`).

## Requirements

- Node.js 22 LTS, pnpm 10
- Docker (Compose v2) for PostgreSQL 16, Redis 7 and S3 storage

## Deployment

CI (`.github/workflows/ci.yml`) checks every PR and publishes the image to GHCR on `main`; the manual **Deploy** workflow
rolls it out to the Ubuntu server (`backend/deploy/`: compose + Caddy, `deploy.sh` with DB dump, migrations and rollback).
Runbook: `docs/DEPLOY.md`.

## Quick start

```bash
cp .env.example .env            # fill bot tokens for real Telegram, or keep TELEGRAM_MODE=off
pnpm install
docker compose up -d postgres redis s3
pnpm migrate
pnpm seed:superadmin            # prints a one-time AuthBot link for BOOTSTRAP_SUPERADMIN_TELEGRAM_ID
pnpm dev:api                    # http://localhost:3000/health, OpenAPI at /api/docs
pnpm dev:worker
```

Full stack in containers: `docker compose --profile app up --build`.

Host ports are configurable through `POSTGRES_PORT`, `REDIS_PORT`, `S3_PORT`, `S3_CONSOLE_PORT`, `API_PORT` in `.env`
(useful when another project already uses 5432 or 6379).

## Quality gates

```bash
pnpm lint          # ESLint (type-aware)
pnpm typecheck     # tsc --noEmit
pnpm format:check  # Prettier
pnpm test:unit     # fast, no containers
pnpm test:integration  # Testcontainers: PostgreSQL, Redis, S3 (needs Docker)
# without Docker: a local PostgreSQL 16 (CREATE DATABASE rights) and Redis, S3 is faked in-process
TEST_SERVICES=local TEST_PG_URL=postgres://user:pass@127.0.0.1:5432/postgres TEST_REDIS_URL=redis://127.0.0.1:6379 pnpm test:integration
pnpm build         # dist/ for apps and libs
```

CI (`../.github/workflows/ci.yml`) runs all of the above plus a Docker image build.

## Conventions

- Business rules live in use-cases inside `libs/modules/*`; bots and controllers are thin adapters.
- Every use-case checks permissions (role + context + link status, spec 8.0), not only the menu.
- Domain events go through the transactional outbox; admin actions go to `audit_log`.
- All user-facing text is i18n (Russian), no literals in handlers.
- IDs are UUID v7 generated in the app; time is `timestamptz` (UTC) with an IANA timezone per account.
