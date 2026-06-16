# Anthos Aftercare

A field-productivity web app that helps support specialists manage their
caseloads — turning a long list of participants into a clear, prioritized set
of actions they can work through on a tablet, online or off.

## What it does

- **Prioritized caseload.** A transparent scoring engine ranks each
  specialist's participants by who most needs attention, so the day opens with
  "who do I act on first?" already answered — and the reasoning behind every
  ranking is shown on screen, never a black box.
- **Tablet-first for the field.** The interface is built for one-handed use on
  a tablet during field visits: large touch targets, a single primary action
  per screen, and fast logging of what happened in the moment.
- **Offline-first.** Connectivity is unreliable in the field, so the app caches
  the caseload locally and queues actions — notes, call logs, updates — while
  offline, then syncs when the connection returns. Replay is conflict-safe, so
  nothing is lost or applied twice.

## Why it helps

Specialists spend less time hunting through records and more time with the
people they support. Prioritization focuses limited hours on the highest-need
cases; the tablet UI removes friction during visits; and offline support keeps
the tool working anywhere, capturing work as it happens instead of relying on
memory and after-the-fact data entry.

## Architecture at a glance

A TypeScript monorepo: a Next.js web app (UI + backend-for-frontend) over a set
of shared packages — domain logic, persistence, auth, and integrations. An
external system of record holds the authoritative participant data; the tool
reads through adapters and writes through idempotent, audited operations.

## Prerequisites

- Node.js 22 (see `.nvmrc` — `22.11.0`)
- pnpm 9 (`corepack enable` will pin `pnpm@9.15.0` from `package.json`)

## Setup

```bash
pnpm install
cp .env.example .env   # then fill in the values (see comments in .env.example)
```

## Develop

```bash
pnpm dev               # Next.js dev server on http://localhost:3000
```

## Build & run

```bash
pnpm build
pnpm --filter @anthos/web start
```

## Quality gates

```bash
pnpm lint              # eslint
pnpm typecheck         # tsc --noEmit across all packages
pnpm test              # unit tests (vitest)
pnpm e2e               # end-to-end tests (Playwright)
```

## Layout

```
apps/web/        Next.js app (SPA + BFF route handlers) and tablet PWA
packages/        Shared workspace packages:
  domain/        Pure business logic (priority engine, state machines) — no I/O
  api/           BFF endpoint handlers
  auth/          Sessions, OAuth 2.0 + PKCE, role resolution
  persistence/   Drizzle ORM, repositories, migrations
  integrations/  Salesforce, Microsoft Graph, email, SMS adapters
  audit/         Audit-log writer
  logging/       Structured logging + PII firewall
  feature-flags/ Feature-flag evaluation
  ai/            AI sidecar (proposal-only; specialists confirm outputs)
salesforce/      Salesforce DX metadata (e.g. the email Flow)
```

## Environment

All configuration is supplied via environment variables — see `.env.example`
for the full list with inline notes on what each value is and how to generate
it. Secrets are server-side only and must never be exposed to the browser.
