ALTER TABLE "logical_models" DROP CONSTRAINT "logical_models_template_pair_check";
--> statement-breakpoint
ALTER TABLE "logical_models" ADD CONSTRAINT "logical_models_template_pair_check" CHECK (("capability_template_key" IS NULL AND "capability_template_version" IS NULL) OR ("capability_template_key" IS NOT NULL AND "capability_template_version" IS NOT NULL AND "capability_template_version" > 0));
--> statement-breakpoint
ALTER TABLE "logical_models" DROP CONSTRAINT "logical_models_schema_pair_check";
--> statement-breakpoint
ALTER TABLE "logical_models" ADD CONSTRAINT "logical_models_schema_pair_check" CHECK (("parameter_schema" IS NULL AND "parameter_schema_version" IS NULL) OR ("parameter_schema" IS NOT NULL AND jsonb_typeof("parameter_schema") = 'object' AND "parameter_schema_version" IS NOT NULL AND "parameter_schema_version" > 0));
--> statement-breakpoint
ALTER TABLE "generation_tasks" DROP CONSTRAINT "generation_tasks_route_snapshot_consistency_check";
--> statement-breakpoint
ALTER TABLE "generation_tasks" ADD CONSTRAINT "generation_tasks_route_snapshot_consistency_check" CHECK (("route_snapshot" IS NULL AND "route_snapshot_version" IS NULL AND "route_snapshot_hash" IS NULL AND "logical_model_pk" IS NULL) OR ("route_snapshot" IS NOT NULL AND "route_snapshot_version" IS NOT NULL AND "route_snapshot_version" > 0 AND "route_snapshot_hash" IS NOT NULL AND "route_snapshot_hash" ~ '^[0-9a-f]{64}$' AND "logical_model_pk" IS NOT NULL));
