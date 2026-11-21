-- 未开放内部报价路径；复用0024专用owner，迁移角色仍只用于DDL。
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
CREATE TABLE "pricing_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"logical_model_pk" uuid NOT NULL,
	"pricing_version" text NOT NULL,
	"config" jsonb NOT NULL,
	"config_hash" text NOT NULL,
	"effective_from_us" numeric NOT NULL,
	"published_at_us" numeric NOT NULL,
	"revoked_at_us" numeric,
	"cancelled_at_us" numeric,
	CONSTRAINT "pricing_versions_config_check" CHECK (jsonb_typeof("pricing_versions"."config") = 'object' AND "pricing_versions"."config_hash" ~ '^[0-9a-f]{64}$' AND "pricing_versions"."pricing_version" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'),
	CONSTRAINT "pricing_versions_time_check" CHECK ("pricing_versions"."published_at_us" BETWEEN 0 AND 253402300799999999 AND "pricing_versions"."published_at_us" = trunc("pricing_versions"."published_at_us") AND "pricing_versions"."effective_from_us" BETWEEN "pricing_versions"."published_at_us" AND 253402300799999999 AND mod("pricing_versions"."effective_from_us", 1000000) = 0 AND ("pricing_versions"."revoked_at_us" IS NULL OR ("pricing_versions"."revoked_at_us" BETWEEN "pricing_versions"."published_at_us" AND 253402300799999999 AND "pricing_versions"."revoked_at_us" = trunc("pricing_versions"."revoked_at_us"))) AND ("pricing_versions"."cancelled_at_us" IS NULL OR ("pricing_versions"."cancelled_at_us" >= "pricing_versions"."published_at_us" AND "pricing_versions"."cancelled_at_us" < "pricing_versions"."effective_from_us" AND "pricing_versions"."cancelled_at_us" = trunc("pricing_versions"."cancelled_at_us"))) AND NOT ("pricing_versions"."revoked_at_us" IS NOT NULL AND "pricing_versions"."cancelled_at_us" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "pricing_quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"pricing_version_id" uuid NOT NULL,
	"snapshot" jsonb NOT NULL,
	"snapshot_hash" text NOT NULL,
	"credit_tenths" numeric NOT NULL,
	"created_at_us" numeric NOT NULL,
	"expires_at_us" numeric NOT NULL,
	CONSTRAINT "pricing_quotes_shape_check" CHECK (jsonb_typeof("pricing_quotes"."snapshot") = 'object' AND "pricing_quotes"."snapshot_hash" ~ '^[0-9a-f]{64}$' AND "pricing_quotes"."request_fingerprint" ~ '^[0-9a-f]{64}$' AND "pricing_quotes"."idempotency_key" ~ '^[A-Za-z0-9._:-]{8,128}$'),
	CONSTRAINT "pricing_quotes_amount_check" CHECK ("pricing_quotes"."credit_tenths" BETWEEN 0 AND 9007199254740991 AND "pricing_quotes"."credit_tenths" = trunc("pricing_quotes"."credit_tenths")),
	CONSTRAINT "pricing_quotes_time_check" CHECK ("pricing_quotes"."created_at_us" BETWEEN 0 AND 253402300799999999 AND "pricing_quotes"."created_at_us" = trunc("pricing_quotes"."created_at_us") AND "pricing_quotes"."expires_at_us" BETWEEN "pricing_quotes"."created_at_us" + 300000000 AND "pricing_quotes"."created_at_us" + 86400000000 AND "pricing_quotes"."expires_at_us" <= 253402300799999999 AND "pricing_quotes"."expires_at_us" = trunc("pricing_quotes"."expires_at_us"))
);
--> statement-breakpoint
ALTER TABLE "pricing_versions" ADD CONSTRAINT "pricing_versions_logical_model_pk_logical_models_id_fk" FOREIGN KEY ("logical_model_pk") REFERENCES "public"."logical_models"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_quotes" ADD CONSTRAINT "pricing_quotes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_quotes" ADD CONSTRAINT "pricing_quotes_pricing_version_id_pricing_versions_id_fk" FOREIGN KEY ("pricing_version_id") REFERENCES "public"."pricing_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pricing_versions_model_version_unique" ON "pricing_versions" USING btree ("logical_model_pk","pricing_version");--> statement-breakpoint
CREATE UNIQUE INDEX "pricing_versions_model_time_unique" ON "pricing_versions" USING btree ("logical_model_pk","effective_from_us");--> statement-breakpoint
CREATE UNIQUE INDEX "pricing_quotes_owner_key_unique" ON "pricing_quotes" USING btree ("owner_id","idempotency_key");--> statement-breakpoint
REVOKE ALL ON public.pricing_versions, public.pricing_quotes FROM PUBLIC;--> statement-breakpoint
-- 独立拒绝函数由本迁移创建，避免后续迁移身份依赖0024已撤销PUBLIC的账本函数执行权。
CREATE FUNCTION public.pricing_reject_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='PRICING_HISTORY_IMMUTABLE';
END;
$fn$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.pricing_reject_mutation() FROM PUBLIC;--> statement-breakpoint
CREATE FUNCTION public.pricing_guard_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
    model record;
    sampled numeric;
BEGIN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(NEW.logical_model_pk::text, 626));
    SELECT id,logical_model_id,catalog_version,enabled,media_type,supported_operations INTO model FROM public.logical_models WHERE id=NEW.logical_model_pk;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='PRICING_MODEL_REQUIRED'; END IF;
    sampled := trunc(extract(epoch FROM pg_catalog.clock_timestamp()) * 1000000);
    IF TG_OP='INSERT' THEN
        IF NEW.config->>'modelId' IS DISTINCT FROM model.logical_model_id
            OR NEW.config->>'modelVersion' IS DISTINCT FROM model.catalog_version::text
            OR NEW.config->>'pricingVersion' IS DISTINCT FROM NEW.pricing_version
            OR NEW.effective_from_us <= sampled OR NEW.revoked_at_us IS NOT NULL OR NEW.cancelled_at_us IS NOT NULL THEN
            RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='PRICING_PUBLISH_INVALID';
        END IF;
        NEW.published_at_us := sampled;
    ELSE
        IF (to_jsonb(NEW) - 'revoked_at_us' - 'cancelled_at_us') IS DISTINCT FROM
            (to_jsonb(OLD) - 'revoked_at_us' - 'cancelled_at_us')
            OR OLD.revoked_at_us IS NOT NULL OR OLD.cancelled_at_us IS NOT NULL
            OR (NEW.revoked_at_us IS NULL) = (NEW.cancelled_at_us IS NULL) THEN
            RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='PRICING_VERSION_IMMUTABLE';
        END IF;
        IF NEW.cancelled_at_us IS NOT NULL THEN
            IF sampled >= OLD.effective_from_us THEN
                RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='PRICING_CANCEL_TOO_LATE';
            END IF;
            NEW.cancelled_at_us := sampled;
        ELSE NEW.revoked_at_us := sampled;
        END IF;
    END IF;
    RETURN NEW;
END;
$fn$;--> statement-breakpoint
CREATE FUNCTION public.pricing_guard_quote() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
    version public.pricing_versions%ROWTYPE;
    model record;
    head uuid;
BEGIN
    SELECT * INTO version FROM public.pricing_versions WHERE id=NEW.pricing_version_id;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(version.logical_model_pk::text, 626));
    SELECT id,logical_model_id,catalog_version,enabled,media_type,supported_operations INTO model FROM public.logical_models WHERE id=version.logical_model_pk;
    SELECT id INTO head FROM public.pricing_versions WHERE logical_model_pk=model.id
        AND published_at_us <= NEW.created_at_us AND effective_from_us <= NEW.created_at_us
        AND cancelled_at_us IS NULL ORDER BY effective_from_us DESC LIMIT 1;
    IF head IS DISTINCT FROM version.id OR NOT model.enabled
        OR version.revoked_at_us <= NEW.created_at_us
        OR NEW.created_at_us > trunc(extract(epoch FROM pg_catalog.clock_timestamp()) * 1000000)
        OR NEW.snapshot->>'modelId' IS DISTINCT FROM model.logical_model_id
        OR NEW.snapshot->>'modelVersion' IS DISTINCT FROM model.catalog_version::text
        OR NEW.snapshot->>'pricingVersion' IS DISTINCT FROM version.pricing_version
        OR NEW.snapshot->>'configHash' IS DISTINCT FROM version.config_hash
        OR NEW.snapshot->'pricingConfig' IS DISTINCT FROM version.config
        OR NEW.snapshot->>'snapshotHash' IS DISTINCT FROM NEW.snapshot_hash
        OR NEW.snapshot->>'credit_tenths' IS DISTINCT FROM NEW.credit_tenths::text
        OR NEW.snapshot->>'createdAtUs' IS DISTINCT FROM NEW.created_at_us::text
        OR NEW.snapshot->>'expiresAtUs' IS DISTINCT FROM NEW.expires_at_us::text
        OR NEW.snapshot->'databaseTime'->>'sampledAtUs' IS DISTINCT FROM NEW.created_at_us::text
        OR NEW.snapshot->'databaseTime'->>'source' IS DISTINCT FROM 'postgresql.clock_timestamp' THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='PRICING_SNAPSHOT_MISMATCH';
    END IF;
    RETURN NEW;
END;
$fn$;--> statement-breakpoint
CREATE TRIGGER pricing_versions_guard BEFORE INSERT OR UPDATE ON public.pricing_versions
FOR EACH ROW EXECUTE FUNCTION public.pricing_guard_version();--> statement-breakpoint
CREATE TRIGGER pricing_versions_history BEFORE DELETE OR TRUNCATE ON public.pricing_versions
FOR EACH STATEMENT EXECUTE FUNCTION public.pricing_reject_mutation();--> statement-breakpoint
CREATE TRIGGER pricing_quotes_guard BEFORE INSERT ON public.pricing_quotes
FOR EACH ROW EXECUTE FUNCTION public.pricing_guard_quote();--> statement-breakpoint
CREATE TRIGGER pricing_quotes_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.pricing_quotes
FOR EACH STATEMENT EXECUTE FUNCTION public.pricing_reject_mutation();--> statement-breakpoint
CREATE FUNCTION public.pricing_lock_model_mutation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
    -- 模型身份不可换键，避免旧ID锁和新ID价格时间轴分裂。
    IF TG_OP='UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.logical_model_id IS DISTINCT FROM OLD.logical_model_id) THEN
        RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='PRICING_MODEL_ID_IMMUTABLE';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(OLD.id::text, 626));
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$fn$;--> statement-breakpoint
CREATE TRIGGER logical_models_pricing_lock BEFORE UPDATE OR DELETE ON public.logical_models
FOR EACH ROW EXECUTE FUNCTION public.pricing_lock_model_mutation();--> statement-breakpoint
CREATE TRIGGER logical_models_pricing_no_truncate BEFORE TRUNCATE ON public.logical_models
FOR EACH STATEMENT EXECUTE FUNCTION public.pricing_reject_mutation();--> statement-breakpoint
REVOKE ALL ON FUNCTION public.pricing_guard_version(), public.pricing_guard_quote(), public.pricing_lock_model_mutation() FROM PUBLIC;--> statement-breakpoint
DO $ownership$
DECLARE
    owner_name text := 'pt_ledger_owner_' || pg_catalog.substr(pg_catalog.md5(pg_catalog.current_database()), 1, 16);
BEGIN
    EXECUTE pg_catalog.format('GRANT USAGE, CREATE ON SCHEMA public TO %I', owner_name);
    EXECUTE pg_catalog.format('GRANT SELECT(id,logical_model_id,catalog_version,enabled,media_type,supported_operations) ON public.logical_models TO %I', owner_name);
    EXECUTE pg_catalog.format('GRANT SELECT, INSERT ON public.pricing_versions, public.pricing_quotes TO %I', owner_name);
    EXECUTE pg_catalog.format('GRANT UPDATE(revoked_at_us,cancelled_at_us) ON public.pricing_versions TO %I', owner_name);
    EXECUTE pg_catalog.format('ALTER FUNCTION public.pricing_reject_mutation() OWNER TO %I', owner_name);
    EXECUTE pg_catalog.format('ALTER FUNCTION public.pricing_guard_version() OWNER TO %I', owner_name);
    EXECUTE pg_catalog.format('ALTER FUNCTION public.pricing_guard_quote() OWNER TO %I', owner_name);
    EXECUTE pg_catalog.format('ALTER FUNCTION public.pricing_lock_model_mutation() OWNER TO %I', owner_name);
    EXECUTE pg_catalog.format('REVOKE CREATE ON SCHEMA public FROM %I', owner_name);
    -- 无EXECUTE授予、无新LOGIN/成员关系；owner与其未来可信JS宿主共同构成信任边界。
END;
$ownership$;
