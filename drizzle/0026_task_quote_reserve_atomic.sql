-- task + quote + reserve 原子协调的最小受限写路径。
-- 仅专用 NOLOGIN ledger owner 可通过未来可信宿主调用；不向 Web/Worker/cleanup 授权。
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
ALTER TABLE public.pricing_quotes ADD COLUMN "task_id" uuid;
--> statement-breakpoint
ALTER TABLE public.pricing_quotes ADD CONSTRAINT "pricing_quotes_task_id_generation_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES public.generation_tasks("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "pricing_quotes_task_unique" ON public.pricing_quotes USING btree ("task_id") WHERE "task_id" IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION public.credit_reserve_task(p_user_id uuid, p_task_id uuid, p_quote_id uuid, p_credit_tenths numeric) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
    account public.credit_accounts%ROWTYPE;
    quote_row public.pricing_quotes%ROWTYPE;
    event_id uuid;
BEGIN
    IF p_user_id IS NULL OR p_task_id IS NULL OR p_quote_id IS NULL
       OR p_credit_tenths IS NULL
       OR p_credit_tenths NOT BETWEEN 1 AND 9223372036854775807
       OR p_credit_tenths <> pg_catalog.trunc(p_credit_tenths) THEN
        RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='CREDIT_AMOUNT_INVALID';
    END IF;
    -- 报价在同一事务内刚插入且历史不可变，无需行锁：加锁子句会要求超出最小权限的UPDATE授权。
    SELECT * INTO quote_row FROM public.pricing_quotes
      WHERE id=p_quote_id AND owner_id=p_user_id AND task_id=p_task_id
        AND credit_tenths=p_credit_tenths;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='23503', MESSAGE='CREDIT_QUOTE_TASK_MISMATCH';
    END IF;
    IF quote_row.expires_at_us <= trunc(extract(epoch FROM pg_catalog.clock_timestamp()) * 1000000) THEN
        RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='CREDIT_QUOTE_EXPIRED';
    END IF;
    -- 扣减与余额判定合并在一条UPDATE中完成，既避免额外表级UPDATE授权，也保证并发下不超额冻结。
    UPDATE public.credit_accounts
       SET available_tenths=available_tenths-p_credit_tenths,
           reserved_tenths=reserved_tenths+p_credit_tenths
     WHERE user_id=p_user_id AND available_tenths>=p_credit_tenths
     RETURNING * INTO account;
    IF NOT FOUND THEN
        IF EXISTS (SELECT 1 FROM public.credit_accounts WHERE user_id=p_user_id) THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='CREDIT_INSUFFICIENT';
        END IF;
        RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='CREDIT_ACCOUNT_NOT_FOUND';
    END IF;
    INSERT INTO public.credit_ledger_events(user_id,task_id,kind,credit_tenths,source_type,source_id,idempotency_key,actor)
      VALUES (p_user_id,p_task_id,'reserve',p_credit_tenths,'task',p_task_id,'reserve:' || p_task_id::text,'system')
      RETURNING id INTO event_id;
    INSERT INTO public.credit_reservations(task_id,user_id,credit_tenths,reserve_event_id)
      VALUES (p_task_id,p_user_id,p_credit_tenths,event_id);
    RETURN event_id;
END;
$fn$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.credit_reserve_task(uuid, uuid, uuid, numeric) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.atomic_reserve_reject_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='CREDIT_RESERVATION_IMMUTABLE';
END;
$fn$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.atomic_reserve_reject_mutation() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER credit_reservations_immutable_guard BEFORE UPDATE OR DELETE OR TRUNCATE ON public.credit_reservations
FOR EACH STATEMENT EXECUTE FUNCTION public.atomic_reserve_reject_mutation();
--> statement-breakpoint
DO $ownership$
DECLARE
    owner_name text := 'pt_ledger_owner_' || pg_catalog.substr(pg_catalog.md5(pg_catalog.current_database()), 1, 16);
BEGIN
    EXECUTE pg_catalog.format('GRANT USAGE, CREATE ON SCHEMA public TO %I', owner_name);
    EXECUTE pg_catalog.format('GRANT SELECT, INSERT(owner_id,idempotency_key,request_fingerprint,task_type,payload,max_attempts,available_at,updated_at,logical_model_pk,route_snapshot,route_snapshot_version,route_snapshot_hash) ON public.generation_tasks TO %I', owner_name);
    EXECUTE pg_catalog.format('GRANT SELECT, INSERT(owner_id,task_id,idempotency_key,request_fingerprint,pricing_version_id,snapshot,snapshot_hash,credit_tenths,created_at_us,expires_at_us) ON public.pricing_quotes TO %I', owner_name);
    EXECUTE pg_catalog.format('GRANT SELECT, UPDATE(available_tenths,reserved_tenths) ON public.credit_accounts TO %I', owner_name);
    -- 事件ID由RETURNING回读，故仅补只读的id列；账本历史仍不可改、不可删。
    EXECUTE pg_catalog.format('GRANT SELECT(id), INSERT(user_id,task_id,kind,credit_tenths,unit_version,source_type,source_id,idempotency_key,actor) ON public.credit_ledger_events TO %I', owner_name);
    EXECUTE pg_catalog.format('GRANT INSERT(task_id,user_id,credit_tenths,reserve_event_id) ON public.credit_reservations TO %I', owner_name);
    EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION public.credit_reserve_task(uuid,uuid,uuid,numeric) TO %I', owner_name);
    EXECUTE pg_catalog.format('ALTER FUNCTION public.credit_reserve_task(uuid,uuid,uuid,numeric) OWNER TO %I', owner_name);
    EXECUTE pg_catalog.format('ALTER FUNCTION public.atomic_reserve_reject_mutation() OWNER TO %I', owner_name);
    EXECUTE pg_catalog.format('REVOKE CREATE ON SCHEMA public FROM %I', owner_name);
END;
$ownership$;
