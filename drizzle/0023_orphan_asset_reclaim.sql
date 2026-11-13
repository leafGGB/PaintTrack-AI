ALTER TABLE "assets" ADD COLUMN "abandoned_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "assets_orphan_pending_idx" ON "assets" USING btree ("created_at") WHERE "assets"."status" IN ('pending', 'uploading') AND "assets"."abandoned_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_abandoned_state_check" CHECK ("assets"."abandoned_at" IS NULL OR ("assets"."status" IN ('pending', 'uploading') AND "assets"."abandoned_at" >= "assets"."created_at"));
