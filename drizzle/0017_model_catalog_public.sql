CREATE VIEW "public"."model_catalog_public" WITH (security_barrier = true) AS (SELECT
        lm.logical_model_id,
        lm.display_name,
        lm.provider_display_name,
        lm.media_type,
        lm.supported_operations,
        lm.capability_template_key,
        lm.capability_template_version,
        lm.parameter_schema_version,
        lm.description,
        lm.icon_key,
        lm.sort_order,
        lm.catalog_version
    FROM logical_models AS lm
    WHERE lm.enabled = true
      AND EXISTS (
          SELECT 1
          FROM model_provider_bindings AS b
          JOIN provider_models AS pm ON pm.id = b.provider_model_id
          JOIN provider_instances AS pi ON pi.id = pm.provider_instance_id
          WHERE b.logical_model_pk = lm.id
            AND b.enabled = true
            AND b.is_primary = true
            AND pm.enabled = true
            AND pm.validation_state = 'verified'
            AND pm.media_type = lm.media_type
            AND pi.enabled = true
      ));