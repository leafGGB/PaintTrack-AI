-- 终态结算扫描：只列出"已终态、已冻结、尚未裁决"的任务，供专用 owner 宿主批量收敛。
-- 扫描只读，不新增任何写入口；真正的裁决仍由 credit_finalize_task 逐笔完成。
-- 不接 HTTP/Worker 入口，不向 Web/Worker/cleanup 授权。
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
-- 结局由任务状态唯一决定：成功→settle，失败/取消→release；排队或执行中不进入候选。
-- 已裁决的任务由 LEFT JOIN 排除，因此重复扫描只会返回剩余未裁决的行。
CREATE FUNCTION public.credit_pending_settlements(p_limit integer)
RETURNS TABLE(task_id uuid, user_id uuid, credit_tenths numeric, outcome text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
        RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='CREDIT_SWEEP_LIMIT_INVALID';
    END IF;
    RETURN QUERY
      SELECT r.task_id, r.user_id, r.credit_tenths,
             CASE WHEN t.status = 'succeeded' THEN 'settle' ELSE 'release' END
        FROM public.credit_reservations r
        JOIN public.generation_tasks t ON t.id = r.task_id AND t.owner_id = r.user_id
        LEFT JOIN public.credit_settlements s ON s.task_id = r.task_id
       WHERE s.task_id IS NULL
         AND t.status IN ('succeeded', 'failed', 'cancelled')
       ORDER BY t.completed_at NULLS LAST, r.task_id
       LIMIT p_limit;
END;
$fn$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.credit_pending_settlements(integer) FROM PUBLIC;
--> statement-breakpoint
DO $ownership$
DECLARE
    owner_name text := 'pt_ledger_owner_' || pg_catalog.substr(pg_catalog.md5(pg_catalog.current_database()), 1, 16);
BEGIN
    EXECUTE pg_catalog.format('GRANT USAGE, CREATE ON SCHEMA public TO %I', owner_name);
    -- 只读列级授权：这些冻结行本就由 owner 写入，读回不增加新信息；仍然不能改、不能删、不能清空。
    EXECUTE pg_catalog.format('GRANT SELECT(task_id,user_id,credit_tenths,reserve_event_id) ON public.credit_reservations TO %I', owner_name);
    EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION public.credit_pending_settlements(integer) TO %I', owner_name);
    EXECUTE pg_catalog.format('ALTER FUNCTION public.credit_pending_settlements(integer) OWNER TO %I', owner_name);
    EXECUTE pg_catalog.format('REVOKE CREATE ON SCHEMA public FROM %I', owner_name);
END;
$ownership$;
