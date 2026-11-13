CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_sessions_hash_check" CHECK ("auth_sessions"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "auth_sessions_expiry_check" CHECK ("auth_sessions"."expires_at" > "auth_sessions"."created_at")
);
--> statement-breakpoint
ALTER TABLE "auth_rate_limits" DROP CONSTRAINT "auth_rate_limits_bucket_check";--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_sessions_token_hash_unique" ON "auth_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_expiry_idx" ON "auth_sessions" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "auth_rate_limits" ADD CONSTRAINT "auth_rate_limits_bucket_check" CHECK ("auth_rate_limits"."bucket" IN ('register', 'verify-email', 'login'));