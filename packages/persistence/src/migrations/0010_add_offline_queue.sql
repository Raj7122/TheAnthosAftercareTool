-- P3C-04: Add `offline_queue` — server-side mirror of the client Outbox per
-- ERD §6.3. Only items that trip the Review Required state machine
-- (TR-OFFLINE-5a) or exhaust the retry budget (TR-OFFLINE-7a) land here; a
-- successful 2xx flush leaves no row (Pattern D's idempotency_keys row is
-- the audit surface for the happy path).
--
-- Maps to TR-OFFLINE-1..9, BR-69, BR-70, SAD §5.3 Path D, Pattern C
-- (offline queue), Pattern E (Review Required state machine). The 7-state
-- vocabulary in the status CHECK is consumed by P3C-08 (state machine) and
-- P3C-05/06/07 (queue endpoints). `idempotency_key` FK keeps the queue row
-- visible after the lock TTLs out at 24h.
--
-- §12.1 places this table in Phase 3 alongside cdc_health; cdc_health was
-- already pulled forward in 0008_add_cdc_health.sql (P1C-03), so this
-- migration covers only the offline_queue half of the Phase-3 row.
--
-- Additive (a new table) — satisfies the post-Phase-1 additive-only rule.
CREATE TABLE "offline_queue" (
	"id" uuid PRIMARY KEY NOT NULL,
	"specialist_id" varchar(50) NOT NULL,
	"participant_id" varchar(50),
	"action_type" varchar(100) NOT NULL,
	"payload" jsonb NOT NULL,
	"idempotency_key" uuid,
	"trace_id" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"retry_count" smallint DEFAULT 0 NOT NULL,
	"status" varchar(40) NOT NULL,
	"error_details" jsonb,
	"resolution_action" varchar(50),
	"resolution_source" varchar(20),
	"resolved_at" timestamp with time zone,
	"resolved_by" varchar(50),
	"resolution_notes" text,
	CONSTRAINT "offline_queue_retry_count_check" CHECK ("offline_queue"."retry_count" >= 0),
	CONSTRAINT "offline_queue_status_check" CHECK ("offline_queue"."status" IN ('pending_sync', 'in_flight', 'completed', 'review_required_reassigned', 'review_required_terminated', 'failed_max_retries', 'discarded')),
	CONSTRAINT "offline_queue_resolution_action_check" CHECK ("offline_queue"."resolution_action" IS NULL OR "offline_queue"."resolution_action" IN ('DISCARD', 'REASSIGN_RETRY', 'ESCALATE_TO_SUPERVISOR')),
	CONSTRAINT "offline_queue_resolution_source_check" CHECK ("offline_queue"."resolution_source" IS NULL OR "offline_queue"."resolution_source" IN ('auto_retry', 'auto_max_retries', 'auto_lock_retry', 'specialist', 'supervisor', 'system'))
);
--> statement-breakpoint
ALTER TABLE "offline_queue" ADD CONSTRAINT "offline_queue_idempotency_key_idempotency_keys_key_fk" FOREIGN KEY ("idempotency_key") REFERENCES "public"."idempotency_keys"("key") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_offline_queue_specialist" ON "offline_queue" USING btree ("specialist_id","status","created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_offline_queue_status" ON "offline_queue" USING btree ("status","created_at" DESC) WHERE status NOT IN ('completed', 'discarded');--> statement-breakpoint
CREATE INDEX "idx_offline_queue_participant" ON "offline_queue" USING btree ("participant_id","status") WHERE participant_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_offline_queue_idempotency" ON "offline_queue" USING btree ("idempotency_key") WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_offline_queue_trace_id" ON "offline_queue" USING btree ("trace_id") WHERE trace_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_offline_queue_resolution_source" ON "offline_queue" USING btree ("resolution_source","resolved_at" DESC) WHERE resolution_source IS NOT NULL;
