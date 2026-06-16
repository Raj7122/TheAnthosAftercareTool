CREATE TABLE "configuration_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" varchar(50) NOT NULL,
	"field_path" varchar(200) NOT NULL,
	"prior_value" jsonb,
	"new_value" jsonb NOT NULL,
	"reason" text NOT NULL,
	"version_from" integer,
	"version_to" integer NOT NULL,
	"approval_metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "configuration" (
	"version" integer PRIMARY KEY NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" varchar(50) NOT NULL,
	"activation_at" timestamp with time zone,
	"deactivated_at" timestamp with time zone,
	"factor_weights" jsonb NOT NULL,
	"tier_thresholds" jsonb NOT NULL,
	"queue_predicates" jsonb NOT NULL,
	"barrier_severity_classification" jsonb NOT NULL,
	"due_status_lead_time_days" smallint DEFAULT 14 NOT NULL,
	"voucher_recert_warning_days" smallint DEFAULT 30 NOT NULL,
	"recent_incident_window_days" smallint DEFAULT 30 NOT NULL,
	"failed_attempt_reset_on_completed" boolean DEFAULT true NOT NULL,
	"recalibration_cadence_days" integer DEFAULT 90 NOT NULL,
	"calibration_alpha" numeric(4, 2) DEFAULT '1.00' NOT NULL,
	"calibration_beta" numeric(4, 2) DEFAULT '2.00' NOT NULL,
	"calibration_threshold_pct" numeric(5, 2) DEFAULT '85.00' NOT NULL,
	"calibration_participants_floor" smallint DEFAULT 10 NOT NULL,
	"sbop_path" char(1) NOT NULL,
	"sbop_suppression_days" integer DEFAULT 14 NOT NULL,
	"sbop_enabled" boolean DEFAULT false NOT NULL,
	"capacity_strain_multiplier" numeric(3, 1) DEFAULT '1.6' NOT NULL,
	"capacity_strain_persistence_days" smallint DEFAULT 4 NOT NULL,
	"quiet_hours_start_local" time DEFAULT '21:00:00' NOT NULL,
	"quiet_hours_end_local" time DEFAULT '08:00:00' NOT NULL,
	"mogli_timeout_seconds" smallint DEFAULT 5 NOT NULL,
	"mogli_backoff_seconds" jsonb DEFAULT '[5, 15, 45, 120, 300]'::jsonb NOT NULL,
	"offline_max_queue_depth" smallint DEFAULT 100 NOT NULL,
	"offline_max_retries" smallint DEFAULT 5 NOT NULL,
	"idempotency_ttl_hours" smallint DEFAULT 24 NOT NULL,
	"hard_refresh_rate_limit_seconds" smallint DEFAULT 30 NOT NULL,
	"nightly_refresh_cron" varchar(50) DEFAULT '0 2 * * *' NOT NULL,
	"weekly_digest_cron" varchar(50) DEFAULT '0 8 * * MON' NOT NULL,
	"daily_digest_cron" varchar(50) DEFAULT '0 8 * * *' NOT NULL,
	"tie_breaker_strategy" varchar(50) DEFAULT 'oldest_contact_then_id' NOT NULL,
	"feature_flags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"approval_metadata" jsonb,
	"notes" text,
	CONSTRAINT "configuration_sbop_path_check" CHECK ("configuration"."sbop_path" IN ('A', 'B', 'C'))
);
--> statement-breakpoint
ALTER TABLE "configuration_audit" ADD CONSTRAINT "configuration_audit_version_from_configuration_version_fk" FOREIGN KEY ("version_from") REFERENCES "public"."configuration"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "configuration_audit" ADD CONSTRAINT "configuration_audit_version_to_configuration_version_fk" FOREIGN KEY ("version_to") REFERENCES "public"."configuration"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_config_audit_timestamp" ON "configuration_audit" USING btree ("timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_config_audit_actor" ON "configuration_audit" USING btree ("actor_id","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_config_audit_field" ON "configuration_audit" USING btree ("field_path","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_config_audit_version_to" ON "configuration_audit" USING btree ("version_to");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_configuration_active" ON "configuration" USING btree ("is_active") WHERE is_active = true;--> statement-breakpoint
CREATE INDEX "idx_configuration_created_at" ON "configuration" USING btree ("created_at" DESC NULLS LAST);