CREATE TABLE IF NOT EXISTS "generation_tasks" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "task_type" text NOT NULL,
    "payload" jsonb NOT NULL,
    "status" text NOT NULL DEFAULT 'queued'
        CHECK ("status" IN ('queued', 'running', 'succeeded', 'failed')),
    "attempts" integer NOT NULL DEFAULT 0 CHECK ("attempts" >= 0),
    "max_attempts" integer NOT NULL DEFAULT 3 CHECK ("max_attempts" > 0),
    "available_at" timestamptz NOT NULL DEFAULT now(),
    "lease_token" uuid,
    "lease_expires_at" timestamptz,
    "worker_id" text,
    "last_error" text,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    "completed_at" timestamptz,
    CONSTRAINT "generation_tasks_lease_consistency_check" CHECK (
        ("status" = 'running' AND "lease_token" IS NOT NULL AND "lease_expires_at" IS NOT NULL)
        OR ("status" <> 'running' AND "lease_token" IS NULL AND "lease_expires_at" IS NULL)
    ),
    CONSTRAINT "generation_tasks_attempt_limit_check" CHECK ("attempts" <= "max_attempts")
);

CREATE INDEX IF NOT EXISTS "generation_tasks_claimable_idx"
    ON "generation_tasks" ("status", "available_at", "created_at");

CREATE INDEX IF NOT EXISTS "generation_tasks_lease_expiry_idx"
    ON "generation_tasks" ("status", "lease_expires_at");
