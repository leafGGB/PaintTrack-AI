-- 冻结额度的终态裁决：只允许专用 NOLOGIN ledger owner 一次性结算或释放。
-- 不接 HTTP/Worker 入口，不向 Web/Worker/cleanup 授权；不做部分结算或跨任务调整。
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
CREATE TABLE "credit_settlements" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"credit_tenths" numeric NOT NULL,
	"event_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_settlements_amount_check" CHECK ("credit_settlements"."credit_tenths" BETWEEN 1 AND 9223372036854775807 AND "credit_settlements"."credit_tenths" = trunc("credit_settlements"."credit_tenths")),
	CONSTRAINT "credit_settlements_kind_check" CHECK ("credit_settlements"."kind" IN ('settle', 'release'))
);
--> statement-breakpoint
ALTER TABLE "credit_ledger_events" DROP CONSTRAINT "credit_ledger_events_shape_check";--> statement-breakpoint
DROP INDEX "credit_ledger_events_task_unique";--> statement-breakpoint
ALTER TABLE "credit_settlements" ADD CONSTRAINT "credit_settlements_task_id_generation_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."generation_tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_settlements" ADD CONSTRAINT "credit_settlements_user_id_credit_accounts_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."credit_accounts"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_settlements" ADD CONSTRAINT "credit_settlements_event_identity_fk" FOREIGN KEY ("event_id","user_id","task_id","credit_tenths") REFERENCES "public"."credit_ledger_events"("id","user_id","task_id","credit_tenths") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_settlements_event_unique" ON "credit_settlements" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_events_task_kind_unique" ON "credit_ledger_events" USING btree ("task_id","kind");--> statement-breakpoint
ALTER TABLE "credit_ledger_events" ADD CONSTRAINT "credit_ledger_events_shape_check" CHECK ("credit_ledger_events"."kind" IN ('reserve', 'settle', 'release') AND "credit_ledger_events"."source_type" = 'task' AND "credit_ledger_events"."source_id" = "credit_ledger_events"."task_id" AND "credit_ledger_events"."actor" = 'system' AND "credit_ledger_events"."idempotency_key" = "credit_ledger_events"."kind" || ':' || "credit_ledger_events"."task_id"::text);
--> statement-breakpoint
-- 终态裁决只追加一行：credit_reservations 保持不可变，任务结局记录在 credit_settlements。
CREATE FUNCTION public.credit_finalize_task(p_user_id uuid, p_task_id uuid, p_outcome text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
    reservation public.credit_reservations%ROWTYPE;
    existing public.credit_settlements%ROWTYPE;
    task_status text;
    account public.credit_accounts%ROWTYPE;
    event_id uuid;
BEGIN
    IF p_user_id IS NULL OR p_task_id IS NULL
       OR p_outcome IS NULL OR p_outcome NOT IN ('settle', 'release') THEN
        RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='CREDIT_OUTCOME_INVALID';
    END IF;
    -- 同一任务的裁决必须串行；advisory lock 不依赖表权限，不需要额外授 UPDATE。
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('credit_finalize:' || p_task_id::text, 627));
    SELECT * INTO existing FROM public.credit_settlements WHERE task_id = p_task_id;
    IF FOUND THEN
        IF existing.user_id <> p_user_id OR existing.kind <> p_outcome THEN
            RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='CREDIT_SETTLE_CONFLICT';
        END IF;
        RETURN existing.event_id;
    END IF;
    SELECT * INTO reservation FROM public.credit_reservations
      WHERE task_id = p_task_id AND user_id = p_user_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='CREDIT_RESERVE_NOT_FOUND';
    END IF;
    SELECT status INTO task_status FROM public.generation_tasks
      WHERE id = p_task_id AND owner_id = p_user_id;
    IF task_status IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='CREDIT_TASK_NOT_FOUND';
    END IF;
    -- 只有成功任务可扣费，只有失败/取消任务可退回；排队或执行中一律拒绝。
    IF (p_outcome = 'settle' AND task_status <> 'succeeded')
       OR (p_outcome = 'release' AND task_status NOT IN ('failed', 'cancelled')) THEN
        RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='CREDIT_TASK_NOT_TERMINAL';
    END IF;
    -- 扣减冻结与退回可用合并为一条UPDATE，避免额外表级UPDATE授权，也不允许出现负冻结。
    UPDATE public.credit_accounts
       SET reserved_tenths = reserved_tenths - reservation.credit_tenths,
           available_tenths = available_tenths
             + CASE WHEN p_outcome = 'release' THEN reservation.credit_tenths ELSE 0 END
     WHERE user_id = p_user_id AND reserved_tenths >= reservation.credit_tenths
     RETURNING * INTO account;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='CREDIT_RESERVED_UNDERFLOW';
    END IF;
    INSERT INTO public.credit_ledger_events(user_id,task_id,kind,credit_tenths,source_type,source_id,idempotency_key,actor)
      VALUES (p_user_id,p_task_id,p_outcome,reservation.credit_tenths,'task',p_task_id,
              p_outcome || ':' || p_task_id::text,'system')
      RETURNING id INTO event_id;
    INSERT INTO public.credit_settlements(task_id,user_id,kind,credit_tenths,event_id)
      VALUES (p_task_id,p_user_id,p_outcome,reservation.credit_tenths,event_id);
    RETURN event_id;
END;
$fn$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.credit_finalize_task(uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.credit_settlement_reject_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='CREDIT_SETTLEMENT_IMMUTABLE';
END;
$fn$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.credit_settlement_reject_mutation() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER credit_settlements_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.credit_settlements
FOR EACH STATEMENT EXECUTE FUNCTION public.credit_settlement_reject_mutation();
--> statement-breakpoint
REVOKE ALL ON public.credit_settlements FROM PUBLIC;
--> statement-breakpoint
DO $ownership$
DECLARE
    owner_name text := 'pt_ledger_owner_' || pg_catalog.substr(pg_catalog.md5(pg_catalog.current_database()), 1, 16);
BEGIN
    EXECUTE pg_catalog.format('GRANT USAGE, CREATE ON SCHEMA public TO %I', owner_name);
    EXECUTE pg_catalog.format('GRANT SELECT, INSERT(task_id,user_id,kind,credit_tenths,event_id) ON public.credit_settlements TO %I', owner_name);
    EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION public.credit_finalize_task(uuid,uuid,text) TO %I', owner_name);
    EXECUTE pg_catalog.format('ALTER FUNCTION public.credit_finalize_task(uuid,uuid,text) OWNER TO %I', owner_name);
    EXECUTE pg_catalog.format('ALTER FUNCTION public.credit_settlement_reject_mutation() OWNER TO %I', owner_name);
    EXECUTE pg_catalog.format('REVOKE CREATE ON SCHEMA public FROM %I', owner_name);
END;
$ownership$;
