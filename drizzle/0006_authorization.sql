ALTER TABLE "users" ADD COLUMN "role" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK ("users"."role" IN ('user', 'admin'));--> statement-breakpoint
-- 已有非所有者表级写授权收紧为列授权；不能让新增role继承整表INSERT/UPDATE。
DO $$
DECLARE target record;
BEGIN
    FOR target IN
        SELECT DISTINCT grantee FROM information_schema.table_privileges
        WHERE table_schema='public' AND table_name='users' AND privilege_type IN ('INSERT','UPDATE')
          AND grantee <> current_user
        UNION
        SELECT DISTINCT grantee FROM information_schema.column_privileges
        WHERE table_schema='public' AND table_name='users' AND column_name='role'
          AND privilege_type IN ('INSERT','UPDATE') AND grantee <> current_user
    LOOP
        EXECUTE format('REVOKE INSERT, UPDATE ON public.users FROM %s', CASE WHEN target.grantee='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(target.grantee) END);
        EXECUTE format('REVOKE INSERT (role), UPDATE (role) ON public.users FROM %s', CASE WHEN target.grantee='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(target.grantee) END);
        IF target.grantee <> 'PUBLIC' THEN
            EXECUTE format('GRANT INSERT (id,email,password_hash,email_verified_at,created_at), UPDATE (email_verified_at) ON public.users TO %I', target.grantee);
        END IF;
    END LOOP;
END $$;