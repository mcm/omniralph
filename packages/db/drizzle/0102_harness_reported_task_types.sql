ALTER TABLE "harnesses" ADD COLUMN "reported_accepted_task_types" text[];--> statement-breakpoint
-- Until the agent reports its local `acceptedTaskTypes`, it keeps the task types it had: its own
-- value, else its organization's `tasks.allowedTypes` (in task type order; absent or not a list of
-- task types is every type), else every type. Soft-deleted agents are filled too.
UPDATE "harnesses" AS h SET "reported_accepted_task_types" = coalesce(
  h."accepted_task_types",
  (
    SELECT array(
      SELECT t."type" FROM unnest(ARRAY['query', 'review', 'coding']) WITH ORDINALITY AS t("type", "n")
      WHERE s."value" ? t."type"
      ORDER BY t."n"
    )
    FROM "app_settings" AS s
    WHERE s."organization_id" = h."organization_id"
      AND s."key" = 'tasks.allowedTypes'
      AND jsonb_typeof(s."value") = 'array'
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(s."value") AS e("value")
        WHERE jsonb_typeof(e."value") <> 'string'
          OR e."value" #>> '{}' NOT IN ('query', 'review', 'coding')
      )
  ),
  ARRAY['query', 'review', 'coding']
);--> statement-breakpoint
ALTER TABLE "harnesses" DROP COLUMN "accepted_task_types";--> statement-breakpoint
DELETE FROM "app_settings" WHERE "key" = 'tasks.allowedTypes';
