CREATE TABLE "password_reset_tokens" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "user_id" uuid NOT NULL,
    "token_hash" text NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "consumed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "password_reset_hash_check" CHECK ("password_reset_tokens"."token_hash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "password_reset_expiry_check" CHECK ("password_reset_tokens"."expires_at" > "password_reset_tokens"."created_at")
);
--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "password_reset_token_hash_unique" ON "password_reset_tokens" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "password_reset_user_idx" ON "password_reset_tokens" USING btree ("user_id");
--> statement-breakpoint
ALTER TABLE "auth_rate_limits" DROP CONSTRAINT "auth_rate_limits_bucket_check";
--> statement-breakpoint
ALTER TABLE "auth_rate_limits" ADD CONSTRAINT "auth_rate_limits_bucket_check" CHECK ("auth_rate_limits"."bucket" IN ('register', 'verify-email', 'login', 'password-reset'));
