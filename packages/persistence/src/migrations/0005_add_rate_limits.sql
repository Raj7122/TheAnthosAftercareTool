-- P1B-03: Add `rate_limits` — the Demo-Mode substrate for application-level
-- per-specialist rate limiting. First consumer is E-03 `POST /auth/refresh`
-- (1 request per 5s per specialist; API §6 / §11.3 anti-loop defense). One row
-- per `<scope>:<subject>` key; the check-and-consume is a single atomic UPSERT.
--
-- Demo-Mode-only artifact: at the Production substrate swap this table is
-- replaced by a Redis token bucket (API §11.3) behind the `RateLimiter` seam,
-- so it is dropped, not migrated. Additive (a new table) — satisfies the
-- Phase-1 additive-only rule. Not enumerated in ERD v1.4 — ERD patch tracked
-- in the PR description.
CREATE TABLE "rate_limits" (
	"key" varchar(150) PRIMARY KEY NOT NULL,
	"last_request_at" timestamp with time zone DEFAULT now() NOT NULL
);
