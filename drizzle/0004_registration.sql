CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"email_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_canonical_check" CHECK ("users"."email" = lower(btrim("users"."email")) AND octet_length("users"."email") BETWEEN 3 AND 254 AND "users"."email" ~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
	CONSTRAINT "users_password_hash_check" CHECK ("users"."password_hash" ~ '^scrypt:32768:8:3:[0-9a-f]{32}:[0-9a-f]{128}$')
);
--> statement-breakpoint
CREATE TABLE "email_verification_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_verification_hash_check" CHECK ("email_verification_tokens"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "email_verification_expiry_check" CHECK ("email_verification_tokens"."expires_at" > "email_verification_tokens"."created_at")
);
--> statement-breakpoint
CREATE TABLE "auth_rate_limits" (
	"bucket" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"hits" integer NOT NULL,
	CONSTRAINT "auth_rate_limits_bucket_check" CHECK ("auth_rate_limits"."bucket" IN ('register', 'verify-email')),
	CONSTRAINT "auth_rate_limits_hits_check" CHECK ("auth_rate_limits"."hits" BETWEEN 1 AND 60)
);
--> statement-breakpoint
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "email_verification_token_hash_unique" ON "email_verification_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "email_verification_user_unique" ON "email_verification_tokens" USING btree ("user_id");