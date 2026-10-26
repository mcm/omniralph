ALTER TABLE "repositories" RENAME COLUMN "enabled" TO "reviews_enabled";--> statement-breakpoint
ALTER TABLE "repositories" RENAME COLUMN "ralph_enabled" TO "coding_enabled";--> statement-breakpoint
ALTER TABLE "repositories" RENAME COLUMN "query_enabled" TO "ask_enabled";--> statement-breakpoint
-- A switch that inherited (null) keeps its effective value: whether the organization's
-- `tasks.allowedTypes` includes its task type, or on when the setting is absent or not a list
-- of task types (`getAllowedTaskTypeDefaults`).
UPDATE "repositories" AS r SET
  "reviews_enabled" = coalesce(r."reviews_enabled", a."allowed" IS NULL OR a."allowed" ? 'review'),
  "coding_enabled" = coalesce(r."coding_enabled", a."allowed" IS NULL OR a."allowed" ? 'coding'),
  "ask_enabled" = coalesce(r."ask_enabled", a."allowed" IS NULL OR a."allowed" ? 'query')
FROM (
  SELECT o."id" AS "organization_id",
    CASE
      WHEN s."value" IS NULL OR jsonb_typeof(s."value") <> 'array' THEN NULL
      WHEN EXISTS (
        SELECT 1 FROM jsonb_array_elements(s."value") AS e("value")
        WHERE jsonb_typeof(e."value") <> 'string'
          OR e."value" #>> '{}' NOT IN ('query', 'review', 'coding')
      ) THEN NULL
      ELSE s."value"
    END AS "allowed"
  FROM "organizations" AS o
  LEFT JOIN "app_settings" AS s
    ON s."organization_id" = o."id" AND s."key" = 'tasks.allowedTypes'
) AS a
WHERE a."organization_id" = r."organization_id"
  AND (r."reviews_enabled" IS NULL OR r."coding_enabled" IS NULL OR r."ask_enabled" IS NULL);--> statement-breakpoint
ALTER TABLE "repositories" ALTER COLUMN "reviews_enabled" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "repositories" ALTER COLUMN "reviews_enabled" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "repositories" ALTER COLUMN "coding_enabled" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "repositories" ALTER COLUMN "coding_enabled" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "repositories" ALTER COLUMN "ask_enabled" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "repositories" ALTER COLUMN "ask_enabled" SET NOT NULL;
