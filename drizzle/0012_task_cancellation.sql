ALTER TABLE "generation_tasks" DROP CONSTRAINT "generation_tasks_status_check";--> statement-breakpoint
ALTER TABLE "generation_tasks" ADD CONSTRAINT "generation_tasks_status_check" CHECK ("generation_tasks"."status" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled'));
