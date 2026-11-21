-- Admin model directory v1: narrow read-only binding projection.
-- The web role receives only EXECUTE on this fixed function; it does not receive
-- SELECT on provider_instances, provider_models, or model_provider_bindings.
DO $guard$
DECLARE
    owner_name text := 'pt_admin_models_owner_' || pg_catalog.substr(pg_catalog.md5(pg_catalog.current_database()), 1, 16);
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = owner_name AND NOT rolcanlogin
        AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
        AND NOT rolreplication AND NOT rolbypassrls)
        OR NOT pg_catalog.pg_has_role(CURRENT_USER, owner_name, 'SET') THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='ADMIN_MODELS_OWNER_NOT_PREPARED';
    END IF;
END
$guard$;
--> statement-breakpoint
CREATE FUNCTION public.admin_model_bindings_read(p_logical_model_pks uuid[])
RETURNS TABLE(logical_model_pk uuid, provider_instance_id uuid, provider_model_id uuid,
    route_role text, route_order integer, binding_version integer, active boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
    binding record;
BEGIN
    IF p_logical_model_pks IS NULL OR cardinality(p_logical_model_pks) > 50
        OR coalesce(array_ndims(p_logical_model_pks), 1) <> 1 THEN
        RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='ADMIN_MODELS_INVALID_BATCH';
    END IF;
    FOR binding IN
        SELECT model.pk, pm.provider_instance_id, b.provider_model_id, b.is_primary,
               b.priority, b.binding_version, b.enabled,
               row_number() OVER (PARTITION BY model.pk ORDER BY b.priority, b.provider_model_id) AS position
          FROM (SELECT DISTINCT pk FROM unnest(p_logical_model_pks) AS input(pk) WHERE pk IS NOT NULL) AS model
          CROSS JOIN LATERAL (
              SELECT mb.provider_model_id, mb.is_primary, mb.priority, mb.binding_version, mb.enabled
                FROM public.model_provider_bindings AS mb
               WHERE mb.logical_model_pk = model.pk
               ORDER BY mb.priority, mb.provider_model_id LIMIT 51
          ) AS b
          JOIN public.provider_models AS pm ON pm.id = b.provider_model_id
         ORDER BY model.pk, b.priority, b.provider_model_id
    LOOP
        IF binding.position > 50 THEN
            RAISE EXCEPTION USING ERRCODE='54000', MESSAGE='ADMIN_MODELS_BINDING_LIMIT_EXCEEDED';
        END IF;
        logical_model_pk := binding.pk;
        provider_instance_id := binding.provider_instance_id;
        provider_model_id := binding.provider_model_id;
        route_role := CASE WHEN binding.is_primary THEN 'primary' ELSE 'secondary' END;
        route_order := binding.priority;
        binding_version := binding.binding_version;
        active := binding.enabled;
        RETURN NEXT;
    END LOOP;
END;
$fn$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_model_bindings_read(uuid[]) FROM PUBLIC;
--> statement-breakpoint
DO $ownership$
DECLARE
    owner_name text := 'pt_admin_models_owner_' || pg_catalog.substr(pg_catalog.md5(pg_catalog.current_database()), 1, 16);
BEGIN
    EXECUTE pg_catalog.format('GRANT USAGE ON SCHEMA public TO %I', owner_name);
    EXECUTE pg_catalog.format('GRANT SELECT(logical_model_pk,provider_model_id,priority,is_primary,enabled,binding_version) ON public.model_provider_bindings TO %I', owner_name);
    EXECUTE pg_catalog.format('GRANT SELECT(id,provider_instance_id) ON public.provider_models TO %I', owner_name);
    EXECUTE pg_catalog.format('GRANT CREATE ON SCHEMA public TO %I', owner_name);
    EXECUTE pg_catalog.format('ALTER FUNCTION public.admin_model_bindings_read(uuid[]) OWNER TO %I', owner_name);
    EXECUTE pg_catalog.format('REVOKE CREATE ON SCHEMA public FROM %I', owner_name);
    IF pg_catalog.has_schema_privilege(owner_name, 'public', 'CREATE') THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='ADMIN_MODELS_OWNER_SCHEMA_CREATE_FORBIDDEN';
    END IF;
END
$ownership$;
