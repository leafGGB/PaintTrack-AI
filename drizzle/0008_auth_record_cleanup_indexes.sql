CREATE INDEX "email_verification_expiry_cleanup_idx" ON "email_verification_tokens" USING btree ("expires_at") WHERE "consumed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "email_verification_consumed_cleanup_idx" ON "email_verification_tokens" USING btree ("consumed_at") WHERE "consumed_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "password_reset_expiry_cleanup_idx" ON "password_reset_tokens" USING btree ("expires_at") WHERE "consumed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "password_reset_consumed_cleanup_idx" ON "password_reset_tokens" USING btree ("consumed_at") WHERE "consumed_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "auth_sessions_expiry_cleanup_idx" ON "auth_sessions" USING btree ("expires_at") WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "auth_sessions_revoked_cleanup_idx" ON "auth_sessions" USING btree ("revoked_at") WHERE "revoked_at" IS NOT NULL;
