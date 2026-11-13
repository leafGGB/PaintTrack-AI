-- 任务归属与幂等键。owner_id 只能来自已认证会话，idempotency_key 在同一个 owner 内唯一。
-- 旧任务没有可归属的用户，任何"猜一个 owner"的回填都会伪造归属，因此这里要求表为空，
-- 让带历史任务的库在迁移阶段明确失败，而不是把匿名任务带进新的安全模型。
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM "generation_tasks") THEN
        RAISE EXCEPTION '0013 requires an empty generation_tasks table: legacy tasks have no owner_id and cannot be attributed safely';
    END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "generation_tasks" ADD COLUMN "owner_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_tasks" ADD COLUMN "idempotency_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_tasks" ADD COLUMN "request_fingerprint" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "generation_tasks_owner_idempotency_unique" ON "generation_tasks" USING btree ("owner_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "generation_tasks_owner_created_idx" ON "generation_tasks" USING btree ("owner_id","created_at");--> statement-breakpoint
ALTER TABLE "generation_tasks" ADD CONSTRAINT "generation_tasks_idempotency_key_check" CHECK ("generation_tasks"."idempotency_key" ~ '^[A-Za-z0-9._:-]{8,128}$');--> statement-breakpoint
ALTER TABLE "generation_tasks" ADD CONSTRAINT "generation_tasks_request_fingerprint_check" CHECK ("generation_tasks"."request_fingerprint" ~ '^[0-9a-f]{64}$');
