CREATE TABLE "provider_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"adapter_type" text NOT NULL,
	"base_url" text NOT NULL,
	"credential_ref" text,
	"credential_version" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"health_state" text DEFAULT 'unknown' NOT NULL,
	"config_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "provider_instances_slug_check" CHECK ("provider_instances"."slug" ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
	CONSTRAINT "provider_instances_credential_version_check" CHECK ("provider_instances"."credential_version" >= 0),
	CONSTRAINT "provider_instances_config_version_check" CHECK ("provider_instances"."config_version" > 0),
	CONSTRAINT "provider_instances_health_state_check" CHECK ("provider_instances"."health_state" IN ('unknown', 'healthy', 'degraded', 'disabled')),
	CONSTRAINT "provider_instances_enabled_disabled_at_check" CHECK (NOT "provider_instances"."enabled" OR "provider_instances"."disabled_at" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "provider_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_instance_id" uuid NOT NULL,
	"upstream_model_name" text NOT NULL,
	"media_type" text NOT NULL,
	"operation_profile" text NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"parameter_mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_mapping_version" integer NOT NULL,
	"response_mapping_version" integer NOT NULL,
	"validation_state" text DEFAULT 'unverified' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "provider_models_media_type_check" CHECK ("provider_models"."media_type" IN ('image', 'video')),
	CONSTRAINT "provider_models_capabilities_object_check" CHECK (jsonb_typeof("provider_models"."capabilities") = 'object'),
	CONSTRAINT "provider_models_parameter_mapping_object_check" CHECK (jsonb_typeof("provider_models"."parameter_mapping") = 'object'),
	CONSTRAINT "provider_models_request_mapping_version_check" CHECK ("provider_models"."request_mapping_version" > 0),
	CONSTRAINT "provider_models_response_mapping_version_check" CHECK ("provider_models"."response_mapping_version" > 0),
	CONSTRAINT "provider_models_validation_state_check" CHECK ("provider_models"."validation_state" IN ('unverified', 'verified', 'disabled')),
	CONSTRAINT "provider_models_enabled_disabled_at_check" CHECK (NOT "provider_models"."enabled" OR "provider_models"."disabled_at" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "logical_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"logical_model_id" text NOT NULL,
	"display_name" text NOT NULL,
	"provider_display_name" text,
	"media_type" text NOT NULL,
	"supported_operations" jsonb NOT NULL,
	"capability_template_key" text,
	"capability_template_version" integer,
	"parameter_schema" jsonb,
	"parameter_schema_version" integer,
	"description" text,
	"icon_key" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"catalog_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "logical_models_logical_model_id_check" CHECK ("logical_models"."logical_model_id" ~ '^[a-z0-9][a-z0-9._-]{1,127}$'),
	CONSTRAINT "logical_models_media_type_check" CHECK ("logical_models"."media_type" IN ('image', 'video')),
	CONSTRAINT "logical_models_supported_operations_array_check" CHECK (jsonb_typeof("logical_models"."supported_operations") = 'array' AND jsonb_array_length("logical_models"."supported_operations") > 0),
	CONSTRAINT "logical_models_template_pair_check" CHECK (("logical_models"."capability_template_key" IS NULL AND "logical_models"."capability_template_version" IS NULL) OR ("logical_models"."capability_template_key" IS NOT NULL AND "logical_models"."capability_template_version" > 0)),
	CONSTRAINT "logical_models_schema_pair_check" CHECK (("logical_models"."parameter_schema" IS NULL AND "logical_models"."parameter_schema_version" IS NULL) OR ("logical_models"."parameter_schema" IS NOT NULL AND jsonb_typeof("logical_models"."parameter_schema") = 'object' AND "logical_models"."parameter_schema_version" > 0)),
	CONSTRAINT "logical_models_catalog_version_check" CHECK ("logical_models"."catalog_version" > 0),
	CONSTRAINT "logical_models_enabled_disabled_at_check" CHECK (NOT "logical_models"."enabled" OR "logical_models"."disabled_at" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "model_provider_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"logical_model_pk" uuid NOT NULL,
	"provider_model_id" uuid NOT NULL,
	"priority" integer NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"binding_version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "model_provider_bindings_priority_check" CHECK ("model_provider_bindings"."priority" > 0),
	CONSTRAINT "model_provider_bindings_version_check" CHECK ("model_provider_bindings"."binding_version" > 0),
	CONSTRAINT "model_provider_bindings_enabled_disabled_at_check" CHECK (NOT "model_provider_bindings"."enabled" OR "model_provider_bindings"."disabled_at" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "provider_config_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"resource_type" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"action" text NOT NULL,
	"config_version_before" integer,
	"config_version_after" integer,
	"change_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_id" text,
	"outcome" text NOT NULL,
	"reason_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_config_audit_resource_type_check" CHECK ("provider_config_audit_events"."resource_type" IN ('provider_instance', 'provider_model', 'logical_model', 'binding')),
	CONSTRAINT "provider_config_audit_action_check" CHECK ("provider_config_audit_events"."action" IN ('create', 'update', 'enable', 'disable', 'credential_rotate', 'validate', 'bind', 'make_primary', 'delete_rejected')),
	CONSTRAINT "provider_config_audit_outcome_check" CHECK ("provider_config_audit_events"."outcome" IN ('succeeded', 'rejected')),
	CONSTRAINT "provider_config_audit_change_summary_object_check" CHECK (jsonb_typeof("provider_config_audit_events"."change_summary") = 'object'),
	CONSTRAINT "provider_config_audit_version_before_check" CHECK ("provider_config_audit_events"."config_version_before" IS NULL OR "provider_config_audit_events"."config_version_before" > 0),
	CONSTRAINT "provider_config_audit_version_after_check" CHECK ("provider_config_audit_events"."config_version_after" IS NULL OR "provider_config_audit_events"."config_version_after" > 0)
);
--> statement-breakpoint
ALTER TABLE "generation_tasks" DROP CONSTRAINT "generation_tasks_cancel_request_check";--> statement-breakpoint
ALTER TABLE "generation_tasks" ADD COLUMN "logical_model_pk" uuid;--> statement-breakpoint
ALTER TABLE "generation_tasks" ADD COLUMN "route_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "generation_tasks" ADD COLUMN "route_snapshot_version" integer;--> statement-breakpoint
ALTER TABLE "generation_tasks" ADD COLUMN "route_snapshot_hash" text;--> statement-breakpoint
ALTER TABLE "provider_calls" ADD COLUMN "provider_instance_id" uuid;--> statement-breakpoint
ALTER TABLE "provider_calls" ADD COLUMN "provider_config_version" integer;--> statement-breakpoint
ALTER TABLE "provider_calls" ADD COLUMN "credential_ref_version" integer;--> statement-breakpoint
ALTER TABLE "provider_calls" ADD COLUMN "provider_model_id" uuid;--> statement-breakpoint
ALTER TABLE "provider_calls" ADD COLUMN "logical_model_id" text;--> statement-breakpoint
ALTER TABLE "provider_calls" ADD COLUMN "binding_id" uuid;--> statement-breakpoint
ALTER TABLE "provider_calls" ADD COLUMN "binding_version" integer;--> statement-breakpoint
ALTER TABLE "provider_calls" ADD COLUMN "adapter_type" text;--> statement-breakpoint
ALTER TABLE "provider_calls" ADD COLUMN "adapter_version" text;--> statement-breakpoint
ALTER TABLE "provider_calls" ADD COLUMN "upstream_model_name" text;--> statement-breakpoint
ALTER TABLE "provider_calls" ADD COLUMN "operation_profile" text;--> statement-breakpoint
ALTER TABLE "provider_calls" ADD COLUMN "route_snapshot_hash" text;--> statement-breakpoint
ALTER TABLE "provider_models" ADD CONSTRAINT "provider_models_provider_instance_id_provider_instances_id_fk" FOREIGN KEY ("provider_instance_id") REFERENCES "public"."provider_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_provider_bindings" ADD CONSTRAINT "model_provider_bindings_logical_model_pk_logical_models_id_fk" FOREIGN KEY ("logical_model_pk") REFERENCES "public"."logical_models"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_provider_bindings" ADD CONSTRAINT "model_provider_bindings_provider_model_id_provider_models_id_fk" FOREIGN KEY ("provider_model_id") REFERENCES "public"."provider_models"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_config_audit_events" ADD CONSTRAINT "provider_config_audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_instances_slug_unique" ON "provider_instances" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "provider_instances_enabled_adapter_idx" ON "provider_instances" USING btree ("enabled","adapter_type");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_models_provider_upstream_profile_unique" ON "provider_models" USING btree ("provider_instance_id","upstream_model_name","operation_profile");--> statement-breakpoint
CREATE INDEX "provider_models_provider_enabled_validation_idx" ON "provider_models" USING btree ("provider_instance_id","enabled","validation_state");--> statement-breakpoint
CREATE UNIQUE INDEX "logical_models_logical_model_id_unique" ON "logical_models" USING btree ("logical_model_id");--> statement-breakpoint
CREATE INDEX "logical_models_directory_idx" ON "logical_models" USING btree ("media_type","enabled","sort_order","logical_model_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_provider_bindings_logical_priority_unique" ON "model_provider_bindings" USING btree ("logical_model_pk","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "model_provider_bindings_logical_provider_model_unique" ON "model_provider_bindings" USING btree ("logical_model_pk","provider_model_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_provider_bindings_one_enabled_primary_unique" ON "model_provider_bindings" USING btree ("logical_model_pk") WHERE "model_provider_bindings"."enabled" AND "model_provider_bindings"."is_primary";--> statement-breakpoint
CREATE INDEX "model_provider_bindings_logical_enabled_priority_idx" ON "model_provider_bindings" USING btree ("logical_model_pk","enabled","priority");--> statement-breakpoint
CREATE INDEX "model_provider_bindings_provider_model_enabled_idx" ON "model_provider_bindings" USING btree ("provider_model_id","enabled");--> statement-breakpoint
CREATE INDEX "provider_config_audit_resource_created_idx" ON "provider_config_audit_events" USING btree ("resource_type","resource_id","created_at");--> statement-breakpoint
CREATE INDEX "provider_config_audit_actor_created_idx" ON "provider_config_audit_events" USING btree ("actor_user_id","created_at");--> statement-breakpoint
ALTER TABLE "generation_tasks" ADD CONSTRAINT "generation_tasks_logical_model_pk_logical_models_id_fk" FOREIGN KEY ("logical_model_pk") REFERENCES "public"."logical_models"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_calls" ADD CONSTRAINT "provider_calls_provider_instance_id_provider_instances_id_fk" FOREIGN KEY ("provider_instance_id") REFERENCES "public"."provider_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_calls" ADD CONSTRAINT "provider_calls_provider_model_id_provider_models_id_fk" FOREIGN KEY ("provider_model_id") REFERENCES "public"."provider_models"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_calls" ADD CONSTRAINT "provider_calls_binding_id_model_provider_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."model_provider_bindings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_calls_provider_instance_created_idx" ON "provider_calls" USING btree ("provider_instance_id","created_at");--> statement-breakpoint
CREATE INDEX "provider_calls_provider_model_created_idx" ON "provider_calls" USING btree ("provider_model_id","created_at");--> statement-breakpoint
ALTER TABLE "generation_tasks" ADD CONSTRAINT "generation_tasks_route_snapshot_object_check" CHECK ("generation_tasks"."route_snapshot" IS NULL OR jsonb_typeof("generation_tasks"."route_snapshot") = 'object');--> statement-breakpoint
ALTER TABLE "generation_tasks" ADD CONSTRAINT "generation_tasks_route_snapshot_consistency_check" CHECK (("generation_tasks"."route_snapshot" IS NULL AND "generation_tasks"."route_snapshot_version" IS NULL AND "generation_tasks"."route_snapshot_hash" IS NULL AND "generation_tasks"."logical_model_pk" IS NULL) OR ("generation_tasks"."route_snapshot" IS NOT NULL AND "generation_tasks"."route_snapshot_version" > 0 AND "generation_tasks"."route_snapshot_hash" ~ '^[0-9a-f]{64}$'));--> statement-breakpoint
ALTER TABLE "generation_tasks" ADD CONSTRAINT "generation_tasks_route_snapshot_hash_check" CHECK ("generation_tasks"."route_snapshot_hash" IS NULL OR "generation_tasks"."route_snapshot_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "generation_tasks" ADD CONSTRAINT "generation_tasks_cancel_request_check" CHECK ("generation_tasks"."cancel_requested_at" IS NULL OR "generation_tasks"."status" IN ('queued', 'running', 'cancelled'));--> statement-breakpoint
ALTER TABLE "provider_calls" ADD CONSTRAINT "provider_calls_route_identity_versions_check" CHECK (("provider_calls"."provider_config_version" IS NULL OR "provider_calls"."provider_config_version" > 0) AND ("provider_calls"."credential_ref_version" IS NULL OR "provider_calls"."credential_ref_version" >= 0) AND ("provider_calls"."binding_version" IS NULL OR "provider_calls"."binding_version" > 0));--> statement-breakpoint
ALTER TABLE "provider_calls" ADD CONSTRAINT "provider_calls_route_snapshot_hash_check" CHECK ("provider_calls"."route_snapshot_hash" IS NULL OR "provider_calls"."route_snapshot_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
