CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"specialist_id" varchar(50) NOT NULL,
	"participant_id" varchar(50),
	"action_type" varchar(100) NOT NULL,
	"outcome" varchar(50) NOT NULL,
	"channel" varchar(30),
	"salesforce_record_id" varchar(50),
	"trace_id" varchar(100),
	"payload_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "audit_log_outcome_check" CHECK ("audit_log"."outcome" IN ('SUCCESS', 'FAILED', 'QUEUED')),
	CONSTRAINT "audit_log_channel_check" CHECK ("audit_log"."channel" IS NULL OR "audit_log"."channel" IN ('phone', 'sms', 'email', 'in_person', 'tablet', 'desktop', 'system'))
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" uuid PRIMARY KEY NOT NULL,
	"specialist_id" varchar(50) NOT NULL,
	"endpoint" varchar(200) NOT NULL,
	"request_hash" varchar(64),
	"status" varchar(20) NOT NULL,
	"response_status_code" smallint,
	"response_body" jsonb,
	"trace_id" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone DEFAULT NOW() + INTERVAL '24 hours' NOT NULL,
	CONSTRAINT "idempotency_keys_status_check" CHECK ("idempotency_keys"."status" IN ('IN_FLIGHT', 'COMPLETED', 'FAILED_TERMINAL'))
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"specialist_id" varchar(50) PRIMARY KEY NOT NULL,
	"weekly_digest_enabled" boolean DEFAULT true NOT NULL,
	"daily_digest_enabled" boolean DEFAULT false NOT NULL,
	"in_app_badge_enabled" boolean DEFAULT true NOT NULL,
	"digest_send_local_time" time DEFAULT '08:00:00' NOT NULL,
	"timezone" varchar(50) DEFAULT 'America/New_York' NOT NULL,
	"last_digest_sent_at" timestamp with time zone,
	"first_run_completed" boolean DEFAULT false NOT NULL,
	"first_run_completed_at" timestamp with time zone,
	"last_session_ended_at" timestamp with time zone,
	"last_seen_tier_1_participant_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(50) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"specialist_id" varchar(50) NOT NULL,
	"role" varchar(30) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT NOW() + INTERVAL '12 hours' NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"revoked_at" timestamp with time zone,
	"revocation_reason" varchar(100),
	"ip_address" "inet",
	"user_agent_hash" varchar(64),
	CONSTRAINT "sessions_role_check" CHECK ("sessions"."role" IN ('SPECIALIST', 'SUPERVISOR', 'VP', 'SYSTEM_ADMIN'))
);
--> statement-breakpoint
CREATE INDEX "idx_audit_log_timestamp" ON "audit_log" USING btree ("timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_audit_log_specialist" ON "audit_log" USING btree ("specialist_id","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_audit_log_participant" ON "audit_log" USING btree ("participant_id","timestamp" DESC NULLS LAST) WHERE participant_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_audit_log_pending_reconciliation" ON "audit_log" USING btree ("action_type","timestamp") WHERE outcome = 'SUCCESS' AND salesforce_record_id IS NULL;--> statement-breakpoint
CREATE INDEX "idx_audit_log_sf_record" ON "audit_log" USING btree ("salesforce_record_id","timestamp" DESC NULLS LAST) WHERE salesforce_record_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_audit_log_channel" ON "audit_log" USING btree ("channel","timestamp" DESC NULLS LAST) WHERE channel IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_audit_log_trace_id" ON "audit_log" USING btree ("trace_id","timestamp" DESC NULLS LAST) WHERE trace_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_idempotency_expires" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_idempotency_specialist" ON "idempotency_keys" USING btree ("specialist_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_idempotency_trace_id" ON "idempotency_keys" USING btree ("trace_id") WHERE trace_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_notif_prefs_weekly" ON "notification_preferences" USING btree ("weekly_digest_enabled","timezone") WHERE weekly_digest_enabled = true;--> statement-breakpoint
CREATE INDEX "idx_notif_prefs_daily" ON "notification_preferences" USING btree ("daily_digest_enabled","timezone") WHERE daily_digest_enabled = true;--> statement-breakpoint
CREATE INDEX "idx_notif_prefs_first_run" ON "notification_preferences" USING btree ("first_run_completed") WHERE first_run_completed = false;--> statement-breakpoint
CREATE INDEX "idx_sessions_specialist" ON "sessions" USING btree ("specialist_id","expires_at");--> statement-breakpoint
CREATE INDEX "idx_sessions_expires" ON "sessions" USING btree ("expires_at") WHERE revoked = false;--> statement-breakpoint
CREATE INDEX "idx_sessions_active_per_specialist" ON "sessions" USING btree ("specialist_id") WHERE revoked = false;
