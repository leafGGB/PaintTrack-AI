-- 仅内部基础；未接入 quote/task/reserve 原子入口，不可收费。
-- 专用 NOLOGIN owner 必须由获准的准备流程预建；迁移不创建角色、不提升身份。
DO $guard$
DECLARE
    owner_name text := 'pt_ledger_owner_' || pg_catalog.substr(pg_catalog.md5(pg_catalog.current_database()), 1, 16);
    owner_oid oid;
BEGIN
    SELECT oid INTO owner_oid FROM pg_catalog.pg_roles
    WHERE rolname = owner_name AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb
      AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND NOT rolinherit;
    IF owner_oid IS NULL OR owner_name = current_user
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = owner_oid)
       OR NOT pg_catalog.pg_has_role(current_user, owner_oid, 'MEMBER') THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'LEDGER_OWNER_NOT_PREPARED';
    END IF;
END;
$guard$;
--> statement-breakpoint
CREATE TABLE "credit_accounts" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"available_tenths" numeric DEFAULT '0' NOT NULL,
	"reserved_tenths" numeric DEFAULT '0' NOT NULL,
	"unit_version" text DEFAULT 'credit_tenths_v1' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_accounts_available_check" CHECK ("credit_accounts"."available_tenths" BETWEEN 0 AND 9223372036854775807 AND "credit_accounts"."available_tenths" = trunc("credit_accounts"."available_tenths")),
	CONSTRAINT "credit_accounts_reserved_check" CHECK ("credit_accounts"."reserved_tenths" BETWEEN 0 AND 9223372036854775807 AND "credit_accounts"."reserved_tenths" = trunc("credit_accounts"."reserved_tenths")),
	CONSTRAINT "credit_accounts_unit_check" CHECK ("credit_accounts"."unit_version" = 'credit_tenths_v1')
);
--> statement-breakpoint
CREATE TABLE "credit_ledger_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"credit_tenths" numeric NOT NULL,
	"unit_version" text DEFAULT 'credit_tenths_v1' NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_ledger_events_amount_check" CHECK ("credit_ledger_events"."credit_tenths" BETWEEN 1 AND 9223372036854775807 AND "credit_ledger_events"."credit_tenths" = trunc("credit_ledger_events"."credit_tenths")),
	CONSTRAINT "credit_ledger_events_unit_check" CHECK ("credit_ledger_events"."unit_version" = 'credit_tenths_v1'),
	CONSTRAINT "credit_ledger_events_shape_check" CHECK ("credit_ledger_events"."kind" = 'reserve' AND "credit_ledger_events"."source_type" = 'task' AND "credit_ledger_events"."source_id" = "credit_ledger_events"."task_id" AND "credit_ledger_events"."actor" = 'system' AND "credit_ledger_events"."idempotency_key" = 'reserve:' || "credit_ledger_events"."task_id"::text)
);
--> statement-breakpoint
CREATE TABLE "credit_reservations" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"credit_tenths" numeric NOT NULL,
	"reserve_event_id" uuid NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_reservations_amount_check" CHECK ("credit_reservations"."credit_tenths" BETWEEN 1 AND 9223372036854775807 AND "credit_reservations"."credit_tenths" = trunc("credit_reservations"."credit_tenths")),
	CONSTRAINT "credit_reservations_status_check" CHECK ("credit_reservations"."status" = 'reserved')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_events_identity_unique" ON "credit_ledger_events" USING btree ("id","user_id","task_id","credit_tenths");--> statement-breakpoint
ALTER TABLE "credit_accounts" ADD CONSTRAINT "credit_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger_events" ADD CONSTRAINT "credit_ledger_events_user_id_credit_accounts_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."credit_accounts"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger_events" ADD CONSTRAINT "credit_ledger_events_task_id_generation_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."generation_tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_task_id_generation_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."generation_tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_user_id_credit_accounts_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."credit_accounts"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_event_identity_fk" FOREIGN KEY ("reserve_event_id","user_id","task_id","credit_tenths") REFERENCES "public"."credit_ledger_events"("id","user_id","task_id","credit_tenths") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_events_key_unique" ON "credit_ledger_events" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_events_task_unique" ON "credit_ledger_events" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_reservations_event_unique" ON "credit_reservations" USING btree ("reserve_event_id");
--> statement-breakpoint
-- 安全扩展不由 Drizzle 表快照描述，单独进行精确门禁和真实 PG 验收。
CREATE FUNCTION public.credit_reject_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'CREDIT_HISTORY_IMMUTABLE';
END;
$fn$;
--> statement-breakpoint
CREATE FUNCTION public.credit_check_task_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
    PERFORM 1 FROM public.generation_tasks AS t WHERE t.id = NEW.task_id AND t.owner_id = NEW.user_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'CREDIT_TASK_OWNER_MISMATCH';
    END IF;
    RETURN NEW;
END;
$fn$;
--> statement-breakpoint
CREATE FUNCTION public.credit_initialize_zero_account(p_user_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'CREDIT_USER_REQUIRED';
    END IF;
    INSERT INTO public.credit_accounts (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;
END;
$fn$;
--> statement-breakpoint
-- 只核验已经存在的 reservation；不创建 task、quote、事件或冻结，不是 reserve API。
CREATE FUNCTION public.credit_assert_reservation_replay(p_task_id uuid, p_credit_tenths numeric) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
    existing public.credit_reservations%ROWTYPE;
BEGIN
    IF p_task_id IS NULL OR p_credit_tenths IS NULL
       OR NOT (p_credit_tenths BETWEEN 1 AND 9223372036854775807)
       OR p_credit_tenths <> pg_catalog.trunc(p_credit_tenths) THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'CREDIT_AMOUNT_INVALID';
    END IF;
    SELECT r.* INTO existing FROM public.credit_reservations AS r WHERE r.task_id = p_task_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'CREDIT_RESERVE_NOT_CONNECTED';
    END IF;
    IF existing.credit_tenths <> p_credit_tenths THEN
        RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'CREDIT_REPLAY_AMOUNT_CONFLICT';
    END IF;
    RETURN existing.reserve_event_id;
END;
$fn$;
--> statement-breakpoint
CREATE TRIGGER credit_ledger_events_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.credit_ledger_events
FOR EACH STATEMENT EXECUTE FUNCTION public.credit_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER credit_reservations_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.credit_reservations
FOR EACH STATEMENT EXECUTE FUNCTION public.credit_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER credit_ledger_events_task_owner BEFORE INSERT ON public.credit_ledger_events
FOR EACH ROW EXECUTE FUNCTION public.credit_check_task_owner();
--> statement-breakpoint
CREATE TRIGGER credit_reservations_task_owner BEFORE INSERT ON public.credit_reservations
FOR EACH ROW EXECUTE FUNCTION public.credit_check_task_owner();
--> statement-breakpoint
REVOKE ALL ON public.credit_accounts, public.credit_ledger_events, public.credit_reservations FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.credit_reject_mutation(), public.credit_check_task_owner(), public.credit_initialize_zero_account(uuid), public.credit_assert_reservation_replay(uuid, numeric) FROM PUBLIC;
--> statement-breakpoint
DO $ownership$
DECLARE
    owner_name text := 'pt_ledger_owner_' || pg_catalog.substr(pg_catalog.md5(pg_catalog.current_database()), 1, 16);
BEGIN
    -- 转移所有权要求目标具有 CREATE；仅在本迁移事务中暂授，末尾撤回。
    EXECUTE pg_catalog.format('GRANT USAGE, CREATE ON SCHEMA public TO %I', owner_name);
    EXECUTE pg_catalog.format('GRANT SELECT ON public.credit_reservations TO %I', owner_name);
    EXECUTE pg_catalog.format('GRANT SELECT(user_id), INSERT(user_id) ON public.credit_accounts TO %I', owner_name);
    EXECUTE pg_catalog.format('GRANT SELECT(id, owner_id) ON public.generation_tasks TO %I', owner_name);
    EXECUTE pg_catalog.format('ALTER FUNCTION public.credit_reject_mutation() OWNER TO %I', owner_name);
    EXECUTE pg_catalog.format('ALTER FUNCTION public.credit_check_task_owner() OWNER TO %I', owner_name);
    EXECUTE pg_catalog.format('ALTER FUNCTION public.credit_initialize_zero_account(uuid) OWNER TO %I', owner_name);
    EXECUTE pg_catalog.format('ALTER FUNCTION public.credit_assert_reservation_replay(uuid, numeric) OWNER TO %I', owner_name);
    EXECUTE pg_catalog.format('REVOKE CREATE ON SCHEMA public FROM %I', owner_name);
    -- 未向迁移身份或任何运行身份授予 EXECUTE；准备脚本还须撤回 DDL 临时成员关系。
END;
$ownership$;