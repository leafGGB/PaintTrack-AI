-- 额度发放：账本新增 grant 事件族，task_id 对发放事件为 NULL。
-- 只允许专用 NOLOGIN ledger owner 通过 credit_grant 写入；不向 Web/Worker/cleanup 授权，不接 HTTP 入口。
DO $guard$
DECLARE
    owner_name text := 'pt_ledger_owner_' || pg_catalog.substr(pg_catalog.md5(pg_catalog.current_database()), 1, 16);
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=owner_name AND NOT rolcanlogin
        AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
        AND NOT rolreplication AND NOT rolbypassrls)
        OR NOT pg_catalog.pg_has_role(current_user, owner_name, 'MEMBER') THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='LEDGER_OWNER_NOT_PREPARED';
    END IF;
END;
$guard$;
--> statement-breakpoint
ALTER TABLE "credit_ledger_events" DROP CONSTRAINT "credit_ledger_events_shape_check";--> statement-breakpoint
ALTER TABLE "credit_ledger_events" ALTER COLUMN "task_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_ledger_events" ADD CONSTRAINT "credit_ledger_events_shape_check" CHECK (("credit_ledger_events"."kind" IN ('reserve', 'settle', 'release') AND "credit_ledger_events"."task_id" IS NOT NULL AND "credit_ledger_events"."source_type" = 'task' AND "credit_ledger_events"."source_id" = "credit_ledger_events"."task_id" AND "credit_ledger_events"."actor" = 'system' AND "credit_ledger_events"."idempotency_key" = "credit_ledger_events"."kind" || ':' || "credit_ledger_events"."task_id"::text) OR ("credit_ledger_events"."kind" = 'grant' AND "credit_ledger_events"."task_id" IS NULL AND "credit_ledger_events"."source_type" IN ('signup', 'manual') AND "credit_ledger_events"."actor" IN ('system', 'admin') AND "credit_ledger_events"."idempotency_key" = 'grant:' || "credit_ledger_events"."source_type" || ':' || "credit_ledger_events"."source_id"::text));
--> statement-breakpoint
-- 发放是账本里唯一的加项：金额、来源、幂等键全部由数据库裁决，调用方只能给来由。
CREATE FUNCTION public.credit_grant(p_user_id uuid, p_credit_tenths numeric, p_source_type text, p_source_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
    event_key text;
    actor_name text;
    existing public.credit_ledger_events%ROWTYPE;
    account public.credit_accounts%ROWTYPE;
    event_id uuid;
BEGIN
    IF p_user_id IS NULL OR p_source_id IS NULL OR p_source_type IS NULL
       OR p_source_type NOT IN ('signup', 'manual')
       OR p_credit_tenths IS NULL
       OR p_credit_tenths NOT BETWEEN 1 AND 9223372036854775807
       OR p_credit_tenths <> pg_catalog.trunc(p_credit_tenths) THEN
        RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='CREDIT_GRANT_INVALID';
    END IF;
    actor_name := CASE p_source_type WHEN 'signup' THEN 'system' ELSE 'admin' END;
    -- 幂等键派生自来源，不接受调用方自定义：同一来由只可能成功一次。
    event_key := 'grant:' || p_source_type || ':' || p_source_id::text;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('credit_grant:' || event_key, 631));
    SELECT * INTO existing FROM public.credit_ledger_events WHERE idempotency_key = event_key;
    IF FOUND THEN
        IF existing.kind <> 'grant' OR existing.user_id <> p_user_id
           OR existing.credit_tenths <> p_credit_tenths THEN
            RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='CREDIT_GRANT_CONFLICT';
        END IF;
        RETURN existing.id;
    END IF;
    -- 开户与入账合并：账户行不存在时先建零账户，随后同一语句加额。
    -- 用户是否存在由 credit_accounts 的外键裁决（owner 不持有 users 的任何读权限）。
    INSERT INTO public.credit_accounts (user_id) VALUES (p_user_id) ON CONFLICT (user_id) DO NOTHING;
    UPDATE public.credit_accounts
       SET available_tenths = available_tenths + p_credit_tenths
     WHERE user_id = p_user_id
       AND available_tenths <= 9223372036854775807 - p_credit_tenths
     RETURNING * INTO account;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='22003', MESSAGE='CREDIT_BALANCE_OVERFLOW';
    END IF;
    INSERT INTO public.credit_ledger_events(user_id,task_id,kind,credit_tenths,source_type,source_id,idempotency_key,actor)
      VALUES (p_user_id,NULL,'grant',p_credit_tenths,p_source_type,p_source_id,event_key,actor_name)
      RETURNING id INTO event_id;
    RETURN event_id;
END;
$fn$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.credit_grant(uuid, numeric, text, uuid) FROM PUBLIC;
--> statement-breakpoint
-- 0024 的任务归属校验只对任务类事件成立：发放事件没有任务，因此换成一个带 WHEN 条件的触发器。
-- 原函数属主是 NOLOGIN owner 且 PUBLIC 没有 EXECUTE，迁移身份既不能改它也不能授它，
-- 所以本迁移新建一个同义函数（归迁移身份所有，可直接挂触发器），随后再把属主交给 owner。
CREATE FUNCTION public.credit_check_ledger_task_owner() RETURNS trigger
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
REVOKE ALL ON FUNCTION public.credit_check_ledger_task_owner() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER credit_ledger_events_task_owner ON public.credit_ledger_events;
--> statement-breakpoint
CREATE TRIGGER credit_ledger_events_task_owner BEFORE INSERT ON public.credit_ledger_events
FOR EACH ROW WHEN (NEW.task_id IS NOT NULL) EXECUTE FUNCTION public.credit_check_ledger_task_owner();
--> statement-breakpoint
DO $ownership$
DECLARE
    owner_name text := 'pt_ledger_owner_' || pg_catalog.substr(pg_catalog.md5(pg_catalog.current_database()), 1, 16);
BEGIN
    EXECUTE pg_catalog.format('GRANT USAGE, CREATE ON SCHEMA public TO %I', owner_name);
    EXECUTE pg_catalog.format('GRANT SELECT(id,user_id,task_id,kind,credit_tenths,unit_version,source_type,source_id,idempotency_key,actor,created_at) ON public.credit_ledger_events TO %I', owner_name);
    EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION public.credit_grant(uuid,numeric,text,uuid) TO %I', owner_name);
    EXECUTE pg_catalog.format('ALTER FUNCTION public.credit_grant(uuid,numeric,text,uuid) OWNER TO %I', owner_name);
    EXECUTE pg_catalog.format('ALTER FUNCTION public.credit_check_ledger_task_owner() OWNER TO %I', owner_name);
    EXECUTE pg_catalog.format('REVOKE CREATE ON SCHEMA public FROM %I', owner_name);
END;
$ownership$;
