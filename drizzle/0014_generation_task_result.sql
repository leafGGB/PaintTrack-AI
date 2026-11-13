ALTER TABLE "generation_tasks" ADD COLUMN "result" jsonb;--> statement-breakpoint
ALTER TABLE "generation_tasks" ADD CONSTRAINT "generation_tasks_result_consistency_check" CHECK (("generation_tasks"."status" = 'succeeded' AND "generation_tasks"."result" IS NOT NULL) OR ("generation_tasks"."status" <> 'succeeded' AND "generation_tasks"."result" IS NULL));--> statement-breakpoint
ALTER TABLE "generation_tasks" ADD CONSTRAINT "generation_tasks_result_object_check" CHECK ("generation_tasks"."result" IS NULL OR jsonb_typeof("generation_tasks"."result") = 'object');
