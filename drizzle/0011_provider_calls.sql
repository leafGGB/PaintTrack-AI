CREATE TABLE IF NOT EXISTS "provider_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"provider_name" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"provider_job_id" text,
	"status" text DEFAULT 'submitting' NOT NULL,
	"recovery_attempts" integer DEFAULT 0 NOT NULL,
	"worker_id" text,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_calls_status_check" CHECK ("provider_calls"."status" IN ('submitting', 'unknown', 'accepted', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "provider_calls_attempt_check" CHECK ("provider_calls"."attempt_no" > 0),
	CONSTRAINT "provider_calls_recovery_attempts_check" CHECK ("provider_calls"."recovery_attempts" >= 0),
	CONSTRAINT "provider_calls_lease_consistency_check" CHECK (("provider_calls"."worker_id" IS NULL AND "provider_calls"."lease_token" IS NULL AND "provider_calls"."lease_expires_at" IS NULL) OR ("provider_calls"."worker_id" IS NOT NULL AND "provider_calls"."lease_token" IS NOT NULL AND "provider_calls"."lease_expires_at" IS NOT NULL)),
	CONSTRAINT "provider_calls_provider_job_status_check" CHECK ("provider_calls"."status" NOT IN ('accepted', 'succeeded', 'cancelled') OR "provider_calls"."provider_job_id" IS NOT NULL),
	CONSTRAINT "provider_calls_error_code_check" CHECK ("provider_calls"."last_error_code" IS NULL OR "provider_calls"."last_error_code" ~ '^[A-Z][A-Z0-9_]{0,63}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "provider_calls_task_attempt_unique" ON "provider_calls" USING btree ("task_id","attempt_no");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "provider_calls_idempotency_unique" ON "provider_calls" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_calls_recovery_idx" ON "provider_calls" USING btree ("status","available_at");