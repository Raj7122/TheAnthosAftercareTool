-- P1C-03: Add `cdc_health` — CDC worker heartbeat + cursor state per ERD §6.9.
-- The Demo-Mode CDC polling worker reads `subscription_states` (per-object
-- ISO-8601 SystemModstamp cursor map) at cycle start, polls Salesforce REST,
-- and UPSERTs heartbeat + advanced cursors on the way out. P1C-04 reads
-- `subscription_status` + `last_heartbeat_at` to surface "data may be stale"
-- when the worker degrades. The Production gRPC subscriber (SAD §12.2, ADR-06)
-- writes the SAME columns — `replay_id` carries the Pub/Sub replay id while
-- `subscription_states` carries per-channel replay state. Schema mirrors
-- ERD §6.9 verbatim; no Demo-only columns. Powers MON-ALERT-11.
--
-- Additive (a new table) — satisfies the Phase-1 additive-only rule.
CREATE TABLE "cdc_health" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" varchar(100) NOT NULL,
	"last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_event_id" varchar(100),
	"last_event_received_at" timestamp with time zone,
	"subscription_status" varchar(30) DEFAULT 'CONNECTED' NOT NULL,
	"subscription_states" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_count_24h" smallint DEFAULT 0 NOT NULL,
	"replay_id" varchar(100),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cdc_health_subscription_status_check" CHECK ("cdc_health"."subscription_status" IN ('CONNECTED', 'PARTIAL', 'RECONNECTING', 'DISCONNECTED', 'STOPPED')),
	CONSTRAINT "cdc_health_worker_id_check" CHECK ("cdc_health"."worker_id" <> '')
);
--> statement-breakpoint
CREATE INDEX "idx_cdc_health_worker" ON "cdc_health" USING btree ("worker_id","updated_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_cdc_health_status" ON "cdc_health" USING btree ("subscription_status","last_heartbeat_at");
