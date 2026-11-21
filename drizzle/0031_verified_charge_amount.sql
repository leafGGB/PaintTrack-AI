-- Additive hardening: expose only a verified charging wrapper. The amount calculator
-- is created by 0030 and is intentionally not recreated in this migration.
CREATE FUNCTION public.credit_charge_task_verified(p_owner_id uuid, p_task_id uuid,
    p_pricing_version_id uuid DEFAULT NULL, p_snapshot jsonb DEFAULT NULL, p_snapshot_hash text DEFAULT NULL,
    p_credit_tenths numeric DEFAULT NULL, p_created_at_us numeric DEFAULT NULL, p_expires_at_us numeric DEFAULT NULL)
RETURNS TABLE(quote_id uuid, credit_tenths numeric, event_id uuid, replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
    IF p_pricing_version_id IS NULL THEN
        RETURN QUERY SELECT * FROM public.credit_charge_task(
            p_owner_id,p_task_id,p_pricing_version_id,p_snapshot,p_snapshot_hash,
            p_credit_tenths,p_created_at_us,p_expires_at_us);
        RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM public.pricing_quotes WHERE task_id=p_task_id) THEN
        RETURN QUERY SELECT * FROM public.credit_charge_task(
            p_owner_id,p_task_id,p_pricing_version_id,p_snapshot,p_snapshot_hash,
            p_credit_tenths,p_created_at_us,p_expires_at_us);
        RETURN;
    END IF;
    IF p_credit_tenths IS DISTINCT FROM public.credit_expected_task_price(p_task_id,p_pricing_version_id) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='CREDIT_CHARGE_INVALID';
    END IF;
    RETURN QUERY SELECT * FROM public.credit_charge_task(
        p_owner_id,p_task_id,p_pricing_version_id,p_snapshot,p_snapshot_hash,
        p_credit_tenths,p_created_at_us,p_expires_at_us);
END;
$fn$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.credit_charge_task_verified(uuid, uuid, uuid, jsonb, text, numeric, numeric, numeric) FROM PUBLIC;
--> statement-breakpoint
DO $ownership$
DECLARE
    owner_name text := 'pt_ledger_owner_' || pg_catalog.substr(pg_catalog.md5(pg_catalog.current_database()), 1, 16);
BEGIN
    EXECUTE pg_catalog.format('GRANT USAGE, CREATE ON SCHEMA public TO %I', owner_name);
    EXECUTE pg_catalog.format('GRANT SELECT(id,logical_model_pk,config) ON public.pricing_versions TO %I', owner_name);
    EXECUTE pg_catalog.format('ALTER FUNCTION public.credit_charge_task_verified(uuid, uuid, uuid, jsonb, text, numeric, numeric, numeric) OWNER TO %I', owner_name);
    EXECUTE pg_catalog.format('REVOKE CREATE ON SCHEMA public FROM %I', owner_name);
END;
$ownership$;
