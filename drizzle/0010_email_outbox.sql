CREATE TABLE "email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"kind" text NOT NULL,
	"recipient_email" text NOT NULL,
	"payload_ciphertext" text NOT NULL,
	"payload_nonce" text NOT NULL,
	"payload_tag" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"sent_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_outbox_status_check" CHECK ("email_outbox"."status" IN ('queued', 'processing', 'sent', 'failed')),
	CONSTRAINT "email_outbox_kind_check" CHECK ("email_outbox"."kind" IN ('verification', 'password-reset')),
	CONSTRAINT "email_outbox_attempts_check" CHECK ("email_outbox"."attempts" >= 0),
	CONSTRAINT "email_outbox_lock_consistency_check" CHECK (("email_outbox"."status" = 'processing' AND "email_outbox"."locked_at" IS NOT NULL AND "email_outbox"."locked_by" IS NOT NULL) OR ("email_outbox"."status" <> 'processing')),
	CONSTRAINT "email_outbox_sent_consistency_check" CHECK (("email_outbox"."status" = 'sent' AND "email_outbox"."sent_at" IS NOT NULL) OR ("email_outbox"."status" <> 'sent' AND "email_outbox"."sent_at" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "email_outbox_idempotency_key_unique" ON "email_outbox" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "email_outbox_delivery_idx" ON "email_outbox" USING btree ("status","available_at","created_at");