CREATE TABLE IF NOT EXISTS "assets" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "owner_id" uuid NOT NULL,
    "media_type" text NOT NULL
        CHECK ("media_type" IN ('image', 'video', 'audio', 'document')),
    "mime_type" text,
    "size_bytes" bigint
        CHECK ("size_bytes" IS NULL OR "size_bytes" >= 0),
    "storage_key" text,
    "thumbnail_storage_key" text,
    "status" text NOT NULL DEFAULT 'pending'
        CHECK ("status" IN ('pending', 'uploading', 'ready', 'failed', 'deleted')),
    "checksum_sha256" text,
    "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    "deleted_at" timestamptz,
    CONSTRAINT "assets_status_storage_consistency_check" CHECK (
        ("status" IN ('pending', 'uploading', 'failed') AND "storage_key" IS NULL)
        OR ("status" IN ('ready', 'deleted') AND "storage_key" IS NOT NULL)
    ),
    CONSTRAINT "assets_deleted_at_consistency_check" CHECK (
        ("status" = 'deleted' AND "deleted_at" IS NOT NULL)
        OR ("status" <> 'deleted' AND "deleted_at" IS NULL)
    ),
    CONSTRAINT "assets_checksum_sha256_format_check" CHECK (
        "checksum_sha256" IS NULL OR "checksum_sha256" ~ '^[0-9a-f]{64}$'
    )
);

CREATE INDEX IF NOT EXISTS "assets_owner_created_idx"
    ON "assets" ("owner_id", "created_at");

CREATE INDEX IF NOT EXISTS "assets_status_created_idx"
    ON "assets" ("status", "created_at");
