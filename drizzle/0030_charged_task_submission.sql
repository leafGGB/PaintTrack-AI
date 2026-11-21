-- 收费提交入口的最小受限写路径：Web 运行身份只能通过这两个 owner 所有的函数
-- 读取价格时间轴、写入报价并冻结额度；不获得定价表与账本的任何直接写权限。
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
-- 报价引擎在应用进程内计算，但价格时间轴必须由数据库给出：运行身份对 pricing_versions
-- 没有也不应获得 SELECT，只能读到计算所需的只读列。
CREATE FUNCTION public.pricing_versions_for_submission(p_logical_model_pk uuid)
RETURNS TABLE(id uuid, pricing_version text, config jsonb, config_hash text,
              effective_from_us numeric, published_at_us numeric,
              revoked_at_us numeric, cancelled_at_us numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
    SELECT v.id, v.pricing_version, v.config, v.config_hash,
           v.effective_from_us, v.published_at_us, v.revoked_at_us, v.cancelled_at_us
      FROM public.pricing_versions AS v
     WHERE v.logical_model_pk = p_logical_model_pk
     ORDER BY v.effective_from_us;
$fn$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.pricing_versions_for_submission(uuid) FROM PUBLIC;
--> statement-breakpoint
-- 数据库侧独立复算用户价格，避免运行身份通过 owner 函数伪造零价或其他金额。
CREATE FUNCTION public.credit_expected_task_price(p_task_id uuid, p_pricing_version_id uuid)
RETURNS numeric
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
    task_row public.generation_tasks%ROWTYPE;
    config jsonb;
    payload jsonb;
    item jsonb;
    band jsonb;
    rate jsonb;
    numerator numeric;
    denominator numeric := 1;
    duration_ms numeric;
    fps_value numeric;
    output_count numeric;
    mode text;
BEGIN
    SELECT * INTO task_row FROM public.generation_tasks WHERE id=p_task_id;
    SELECT v.config INTO config FROM public.pricing_versions AS v
     WHERE v.id=p_pricing_version_id AND v.logical_model_pk=task_row.logical_model_pk;
    IF task_row.id IS NULL OR config IS NULL THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='CREDIT_CHARGE_INVALID'; END IF;
    payload := task_row.payload;
    IF task_row.task_type='image.generate' AND config->>'templateType'='image_resolution_quantity' THEN
        output_count := (payload->>'outputCount')::numeric;
        SELECT value INTO item FROM pg_catalog.jsonb_array_elements(config->'resolutions') AS value
         WHERE value->>'resolutionKey'=payload->>'size' AND value->>'enabled'='true' LIMIT 1;
        IF item IS NULL OR output_count<>1 OR output_count>(config->>'maxOutputCount')::numeric THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='CREDIT_CHARGE_INVALID';
        END IF;
        mode := config->>'quantityMode';
        IF mode='per_unit' THEN numerator := (item->>'unitPriceTenths')::numeric * output_count;
        ELSIF mode='base_plus_increment' THEN numerator := (item->>'basePriceTenths')::numeric + (item->>'incrementPriceTenths')::numeric*(output_count-1);
        ELSIF mode='tiered_total' THEN
            SELECT value INTO band FROM pg_catalog.jsonb_array_elements(item->'quantityBands') AS value
             WHERE output_count >= (value->>'start')::numeric AND output_count < (value->>'end')::numeric LIMIT 1;
            IF band IS NULL THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='CREDIT_CHARGE_INVALID'; END IF;
            numerator := (band->>'totalPriceTenths')::numeric;
        ELSE RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='CREDIT_CHARGE_INVALID'; END IF;
    ELSIF task_row.task_type='video.generate' AND config->>'templateType'='video_duration_fps' THEN
        duration_ms := (payload->>'durationMs')::numeric;
        fps_value := (payload->>'fps')::numeric;
        SELECT value INTO band FROM pg_catalog.jsonb_array_elements(config->'durationBands') AS value
         WHERE duration_ms >= (value->>'start')::numeric AND duration_ms < (value->>'end')::numeric AND value->>'enabled'='true' LIMIT 1;
        SELECT value INTO rate FROM pg_catalog.jsonb_array_elements(config->'fpsRates') AS value
         WHERE fps_value=(value->>'fps')::numeric AND value->>'enabled'='true' LIMIT 1;
        IF band IS NULL OR rate IS NULL OR duration_ms<(config->>'minDurationMs')::numeric OR duration_ms>(config->>'maxDurationMs')::numeric THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='CREDIT_CHARGE_INVALID';
        END IF;
        numerator := (band->>'unitPriceTenths')::numeric*(rate->>'numerator')::numeric;
        denominator := (rate->>'denominator')::numeric;
        mode := config->>'durationMode';
        IF mode='per_second' THEN numerator := numerator*duration_ms; denominator := denominator*1000;
        ELSIF mode='per_frame' THEN
            numerator := numerator*duration_ms*fps_value; denominator := denominator*1000;
            IF numerator%denominator<>0 THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='CREDIT_CHARGE_INVALID'; END IF;
        ELSIF mode<>'band_total' THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='CREDIT_CHARGE_INVALID'; END IF;
    ELSE RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='CREDIT_CHARGE_INVALID'; END IF;
    RETURN pg_catalog.ceil(numerator/denominator);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR division_by_zero THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='CREDIT_CHARGE_INVALID';
END;
$fn$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.credit_expected_task_price(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
-- 报价写入与冻结在同一个函数里完成：要么报价与冻结同时成立，要么整体回滚。
-- 幂等重放只回既有报价与冻结事件，不重复扣减，也不接受调用方临时改价。
CREATE FUNCTION public.credit_charge_task(p_owner_id uuid, p_task_id uuid,
    p_pricing_version_id uuid DEFAULT NULL, p_snapshot jsonb DEFAULT NULL,
    p_snapshot_hash text DEFAULT NULL, p_credit_tenths numeric DEFAULT NULL,
    p_created_at_us numeric DEFAULT NULL, p_expires_at_us numeric DEFAULT NULL)
RETURNS TABLE(quote_id uuid, credit_tenths numeric, event_id uuid, replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
    task_row public.generation_tasks%ROWTYPE;
    existing public.pricing_quotes%ROWTYPE;
    existing_event uuid;
    version_model uuid;
    new_quote_id uuid;
    new_event_id uuid;
BEGIN
    IF p_owner_id IS NULL OR p_task_id IS NULL THEN
        RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='CREDIT_CHARGE_INVALID';
    END IF;
    SELECT * INTO task_row FROM public.generation_tasks AS t
      WHERE t.id = p_task_id AND t.owner_id = p_owner_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE='23503', MESSAGE='CREDIT_TASK_NOT_FOUND';
    END IF;
    -- 同一任务的并发提交只允许一次入账：重放路径与会话锁配合，仍由数据库串行兜底。
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('credit_charge:' || p_task_id::text, 629));
    SELECT q.* INTO existing FROM public.pricing_quotes AS q WHERE q.task_id = p_task_id;
    IF FOUND THEN
        SELECT r.reserve_event_id INTO existing_event FROM public.credit_reservations AS r WHERE r.task_id = p_task_id;
        RETURN QUERY SELECT existing.id, existing.credit_tenths, existing_event, true;
        RETURN;
    END IF;
    -- 免费档位（0 credit_tenths）同样落一条不可变报价，只是不产生冻结与账本事件。
    IF p_pricing_version_id IS NULL OR p_snapshot IS NULL OR p_snapshot_hash IS NULL
       OR p_credit_tenths IS NULL OR p_created_at_us IS NULL OR p_expires_at_us IS NULL
       OR p_credit_tenths NOT BETWEEN 0 AND 9007199254740991
       OR p_credit_tenths <> pg_catalog.trunc(p_credit_tenths)
       OR p_snapshot_hash !~ '^[0-9a-f]{64}$'
       OR pg_catalog.jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object'
       OR p_snapshot->>'credit_tenths' IS DISTINCT FROM p_credit_tenths::text THEN
        RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='CREDIT_CHARGE_INVALID';
    END IF;
    SELECT v.logical_model_pk INTO version_model FROM public.pricing_versions AS v WHERE v.id = p_pricing_version_id;
    IF version_model IS NULL OR version_model IS DISTINCT FROM task_row.logical_model_pk THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='CREDIT_QUOTE_MODEL_MISMATCH';
    END IF;
    INSERT INTO public.pricing_quotes
        (owner_id,task_id,idempotency_key,request_fingerprint,pricing_version_id,
         snapshot,snapshot_hash,credit_tenths,created_at_us,expires_at_us)
      VALUES (p_owner_id,p_task_id,task_row.idempotency_key,task_row.request_fingerprint,p_pricing_version_id,
              p_snapshot,p_snapshot_hash,p_credit_tenths,p_created_at_us,p_expires_at_us)
      RETURNING id INTO new_quote_id;
    IF p_credit_tenths > 0 THEN
        new_event_id := public.credit_reserve_task(p_owner_id, p_task_id, new_quote_id, p_credit_tenths);
    END IF;
    RETURN QUERY SELECT new_quote_id, p_credit_tenths, new_event_id, false;
END;
$fn$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.credit_charge_task(uuid, uuid, uuid, jsonb, text, numeric, numeric, numeric) FROM PUBLIC;
--> statement-breakpoint
-- 函数属主是 ledger owner，PUBLIC 已被撤销执行权；运行角色的执行权由本机注册/验收流程
-- 以「切换为 owner 后授权」的方式追加（见 runtimePermissions.grantChargedSubmissionPermissions），
-- 迁移文件本身不假设运行角色的存在，也不给迁移身份留下转授权。
DO $ownership$
DECLARE
    owner_name text := 'pt_ledger_owner_' || pg_catalog.substr(pg_catalog.md5(pg_catalog.current_database()), 1, 16);
BEGIN
    -- ALTER FUNCTION ... OWNER TO 要求新属主对函数所在 schema 有 CREATE，临时授予后立刻收回。
    EXECUTE pg_catalog.format('GRANT USAGE, CREATE ON SCHEMA public TO %I', owner_name);
    EXECUTE pg_catalog.format('GRANT SELECT(id,logical_model_id,catalog_version) ON public.logical_models TO %I', owner_name);
    EXECUTE pg_catalog.format('GRANT SELECT(id,logical_model_pk,config) ON public.pricing_versions TO %I', owner_name);
    EXECUTE pg_catalog.format('GRANT SELECT(id,owner_id,task_type,payload,logical_model_pk) ON public.generation_tasks TO %I', owner_name);
    EXECUTE pg_catalog.format('ALTER FUNCTION public.pricing_versions_for_submission(uuid) OWNER TO %I', owner_name);
    EXECUTE pg_catalog.format('ALTER FUNCTION public.credit_expected_task_price(uuid, uuid) OWNER TO %I', owner_name);
    EXECUTE pg_catalog.format('ALTER FUNCTION public.credit_charge_task(uuid, uuid, uuid, jsonb, text, numeric, numeric, numeric) OWNER TO %I', owner_name);
    EXECUTE pg_catalog.format('REVOKE CREATE ON SCHEMA public FROM %I', owner_name);
END;
$ownership$;
