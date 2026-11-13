CREATE TABLE "admin_mfa_factors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"factor_type" text DEFAULT 'totp' NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"secret_nonce" text NOT NULL,
	"secret_tag" text NOT NULL,
	"enabled_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_mfa_factors_type_check" CHECK ("admin_mfa_factors"."factor_type" IN ('totp')),
	CONSTRAINT "admin_mfa_factors_lifecycle_check" CHECK (("admin_mfa_factors"."enabled_at" IS NULL AND "admin_mfa_factors"."revoked_at" IS NULL) OR ("admin_mfa_factors"."enabled_at" IS NOT NULL AND "admin_mfa_factors"."revoked_at" IS NULL) OR ("admin_mfa_factors"."revoked_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "admin_recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_digest" text NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_recovery_codes_digest_check" CHECK ("admin_recovery_codes"."code_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "auth_level" text DEFAULT 'password' NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "mfa_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "step_up_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admin_mfa_factors" ADD CONSTRAINT "admin_mfa_factors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_recovery_codes" ADD CONSTRAINT "admin_recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_mfa_factors_user_type_unique" ON "admin_mfa_factors" USING btree ("user_id","factor_type");--> statement-breakpoint
CREATE INDEX "admin_mfa_factors_user_idx" ON "admin_mfa_factors" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_recovery_codes_digest_unique" ON "admin_recovery_codes" USING btree ("code_digest");--> statement-breakpoint
CREATE INDEX "admin_recovery_codes_user_idx" ON "admin_recovery_codes" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_auth_level_check" CHECK ("auth_sessions"."auth_level" IN ('password', 'mfa'));--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_mfa_timestamp_check" CHECK (("auth_sessions"."auth_level" = 'password' AND "auth_sessions"."mfa_verified_at" IS NULL) OR ("auth_sessions"."auth_level" = 'mfa' AND "auth_sessions"."mfa_verified_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_step_up_timestamp_check" CHECK ("auth_sessions"."step_up_verified_at" IS NULL OR "auth_sessions"."auth_level" = 'mfa');