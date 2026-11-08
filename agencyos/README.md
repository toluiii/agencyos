# AgencyOS

Multi-tenant operations platform for digital agencies: clients, projects, Kanban delivery, a scoped
client portal, support, documents, invoicing with Stripe test payments, notifications, real-data
analytics and an OpenAI assistant that refuses to invent results when it is not configured.

Built by **Nour Yahyaoui** as a full-stack portfolio project for the **Nexorlio Junior Full-Stack
Developer** application. Everything in this repository is runnable source code; the documentation
separates what is *implemented and tested* from what is *configured but unverified* and what is
*proposed*.

---

## 1. Status at a glance (verified 2026-11-06, Europe/Paris)

| Check | Command | Result |
| --- | --- | --- |
| API production build | `npm run build -w @agencyos/api` | **pass** (exit 0) |
| Web production build | `npm run build -w @agencyos/web` | **pass**, 23 routes |
| Lint (both workspaces) | `npm run lint` | **0 errors**, 36 warnings (`no-explicit-any` in the API) |
| Unit tests | `npm run test` | **11 passed / 11**, 4 suites |
| Integration tests (real PostgreSQL) | `npm run test:integration` | **15 passed / 15** |
| End-to-end tests (Chromium) | `npx playwright test` | **4 passed / 4** |
| Migrations | `npx prisma migrate status` | 2 migrations, **database up to date** |
| API surface | `npm run openapi` | 66 paths / 85 operations / 31 schemas |

Test machine: Debian 13, 2 vCPU, ~2 GB RAM, Node v20.20.2, npm 10.8.2, PostgreSQL 17.11.
Details, coverage boundaries and known gaps: [docs/TESTING.md](docs/TESTING.md).

**Not verified:** Docker images and Compose (no Docker daemon in the build sandbox), GitHub Actions
runs (repository not pushed), and every third-party provider call (Stripe live/test keys, OpenAI,
Resend, S3 were unavailable). Those paths are implemented, guarded and documented as unavailable at
runtime — see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## 2. What is implemented

| Area | Highlights |
| --- | --- |
| Tenancy & RBAC | 5 roles (`SUPER_ADMIN`, `OWNER`, `MANAGER`, `DEVELOPER`, `CLIENT`), organization switcher, every query scoped server-side by `organizationId` + role scope, composite tenant foreign keys |
| Auth | bcrypt password hashing, access/refresh cookies, refresh-token families with rotation and reuse revocation, CSRF double-submit for cookie sessions, password reset, invitation acceptance |
| Clients | CRUD, contacts, onboarding checklist that activates the client, account manager, activity feed |
| Projects & tasks | Projects with members and milestones, Kanban with drag & drop, task dependencies with cycle detection, "cannot complete before prerequisites" rule, workload and timeline views |
| Client portal | Same application, scoped navigation and data: read-only board, own projects, tickets, invoices, documents |
| Support | Tickets with priority/status workflow, threaded comments, assignment, client-scoped visibility |
| Documents | Upload (10 MB, MIME allow-list), authenticated download, local disk in development or S3 when configured, tenant-scoped deletion rules |
| Billing | Server-calculated invoice totals, send/void, Stripe Checkout session creation, signature-verified idempotent webhooks, subscription state, no card data stored |
| Notifications | In-app notifications, deadline reminder cron with dedupe keys, email through Resend when configured (otherwise explicitly reported as not delivered) |
| Analytics | Dashboard KPIs, 6-month revenue from succeeded payments, task status mix, workload, project performance — all computed from database rows |
| AI assistant | 6 grounded analyses over tenant-scoped context; returns `503 AI_UNAVAILABLE` with no fabricated output when `OPENAI_API_KEY` is missing |
| Admin | Platform overview, organizations, users, audit log (super admin only) |

## 3. Stack

- **Web:** Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS, shadcn-style Radix primitives,
  TanStack Query v5, React Hook Form + Zod, dnd-kit, Recharts.
- **API:** NestJS 11, REST under `/api/v1`, Swagger/OpenAPI, class-validator DTOs, Zod env validation,
  Helmet, throttling, structured request logging with request ids.
- **Data:** PostgreSQL 17 + Prisma 6 (23 models, 12 enums, 45 indexes, 2 migrations).
- **Integrations:** Stripe, OpenAI, Resend, S3-compatible storage — all optional, all lazy, all honest
  about availability via `GET /api/v1/integrations/status`.
- **Quality:** Jest + Supertest (unit + integration), Playwright (e2e), ESLint 9, GitHub Actions,
  Dockerfiles + Compose.

Architecture rationale and trade-offs: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## 4. Quickstart (local, no Docker)

```bash
# 1. PostgreSQL 17 running locally, then:
psql -U postgres -c "CREATE ROLE agencyos LOGIN PASSWORD 'agencyos_dev' CREATEDB;"
psql -U postgres -c "CREATE DATABASE agencyos OWNER agencyos;"
psql -U postgres -c "CREATE DATABASE agencyos_test OWNER agencyos;"

# 2. Environment
cp .env.example .env
cp apps/web/.env.example apps/web/.env.local     # Next.js does not read the monorepo root .env
# edit .env: JWT_ACCESS_SECRET / JWT_REFRESH_SECRET must be random, >= 32 characters

# 3. Install, migrate, seed
npm ci
npm run db:generate
npm run db:deploy
npm run db:seed

# 4. Run
npm run dev            # API http://localhost:4000, Web http://localhost:3000
```

- App: <http://localhost:3000>
- Swagger UI: <http://localhost:4000/api/docs> (also proxied at <http://localhost:3000/api/docs>)
- Health: `/api/v1/health/live`, `/api/v1/health/ready` (ready checks the database)

The browser only ever calls the same-origin path `/api/v1`; Next.js rewrites proxy it to
`API_INTERNAL_URL`. No CORS surprises, no `localhost` hardcoded in client code.

### Demo accounts (seeded, password `DemoPass123!`)

| Email | Role | Organization |
| --- | --- | --- |
| `owner@agencyos.dev` | OWNER (Nour Yahyaoui) | Northstar Studio |
| `manager@agencyos.dev` | MANAGER | Northstar Studio |
| `dev@agencyos.dev` | DEVELOPER | Northstar Studio |
| `dev2@agencyos.dev` | DEVELOPER | Northstar Studio |
| `client@agencyos.dev` | CLIENT | Northstar Studio → Acme Robotics |
| `admin@agencyos.dev` | SUPER_ADMIN + OWNER | Northstar Studio |
| `other@agencyos.dev` | OWNER | Bluewave Labs (isolation fixture) |

The seed is deterministic (`seed-*` ids) and refuses to run when `NODE_ENV=production`.

### Demo activity data (optional)

For a fuller demo workspace (~4 months of clients, tasks, invoices, notifications and audit
events), run the additive activity seed after the base seed:

```bash
npm run db:seed:activity
```

This inserts ~1,400 clearly-labelled synthetic rows (`demo-activity-*` ids, example.com
domains, fictional companies) into the same organization. It is deterministic, idempotent
(re-running replaces exactly those rows) and refuses to run when `NODE_ENV=production`.
Remove them any time by deleting rows whose ids start with `demo-activity-` (and webhook
events whose `eventId` starts with `demo-activity-wh-`). All payment/webhook records carry
`demo_*` provider ids and are not live Stripe transactions.

## 5. Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | API + Web in watch mode |
| `npm run build` | Production builds for both workspaces |
| `npm run lint` | ESLint across API and Web |
| `npm run test` | Unit tests (no database) |
| `npm run test:integration` | Supertest against a real PostgreSQL test database (migrations applied by the harness, tables truncated between runs) |
| `npm run test:e2e` | Playwright against production builds (run `npm run build` first) |
| `npm run test:e2e:ci` | Build, then Playwright |
| `npm run verify` | lint + build + unit + integration |
| `npm run db:deploy` / `db:migrate` / `db:seed` / `db:studio` | Prisma lifecycle |
| `npm run openapi` | Regenerate `docs/openapi.json` from the Nest application |

## 6. Repository map

```
apps/api      NestJS modules, Prisma schema/migrations/seed, Jest suites, OpenAPI export
apps/web      Next.js App Router: (app) group, auth pages, UI primitives, query hooks
e2e           Playwright specs (agency workflow, client portal, auth + billing)
docs          Architecture, API, testing, deployment, roadmap, diagrams, screenshots, dossier
docker        Container entrypoint (migrate deploy, optional seed, then node)
../.github    CI + Docker workflows, issue/PR templates, Dependabot (repository root)
```

## 7. Documentation

- [ARCHITECTURE](docs/ARCHITECTURE.md) — boundaries, tenancy, request lifecycle, decisions
- [API](docs/API.md) — conventions, RBAC matrix, errors, pagination
- [TESTING](docs/TESTING.md) — what each layer proves, real results, gaps
- [DEPLOYMENT](docs/DEPLOYMENT.md) — env matrix, Vercel + managed API + managed Postgres, Docker checklist
- [SECURITY](SECURITY.md) — threat model, controls, reporting
- [ROADMAP](docs/ROADMAP.md) — milestones and what is deliberately out of scope
- [REQUIREMENTS_MAPPING](docs/REQUIREMENTS_MAPPING.md) — Nexorlio requirement-by-requirement status
- [DEMO_SCRIPT](docs/DEMO_SCRIPT.md) — 10-minute interview walkthrough
- [SAMPLE_ISSUES](docs/SAMPLE_ISSUES.md) — backlog written the way the team would work
- [CONTRIBUTING](CONTRIBUTING.md) — workflow, definition of done

## 8. Honest limitations

- Docker/Compose files and CI workflows are authored but were **not executed** here.
- Stripe, OpenAI, Resend and S3 code paths are implemented and unit/integration-tested with signed
  test events and explicit unavailable states; no live provider account was called.
- No production deployment, no real users, no traffic metrics, no load tests.
- Row-level tenancy is enforced in the application layer (Prisma + guards), not by PostgreSQL RLS.
- The API code style is intentionally dense (many one-line handlers); readability refactoring is a
  tracked roadmap item, not a hidden defect.