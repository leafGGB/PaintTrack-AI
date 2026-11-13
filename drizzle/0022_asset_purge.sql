ALTER TABLE "assets" ADD COLUMN "purged_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "purge_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "last_purge_error" text;
--> statement-breakpoint
CREATE INDEX "assets_purge_pending_idx" ON "assets" USING btree ("deleted_at") WHERE "assets"."status" = 'deleted' AND "assets"."purged_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_purge_attempts_check" CHECK ("assets"."purge_attempts" >= 0);
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_purge_state_check" CHECK ("assets"."purged_at" IS NULL OR ("assets"."status" = 'deleted' AND "assets"."purged_at" >= "assets"."deleted_at"));
