-- Turn each organization's routing rules into per-repo work item matches. A rule converts when
-- its group is AND, not negated and not nested, it tests `team =` exactly once, and it may also
-- test the project (`=` a name, or `is empty`) and `labels containsAny`, at most once each. Its
-- repo must have no other rule and no match yet. An organization converts only when every one of
-- its rules converts and no two of its matches (new or existing) conflict: the same team and
-- project condition with label sets that intersect or are both empty. Only then do first-match
-- rules and most-specific matches route every work item alike. Otherwise its rules stay as they
-- are and no match is created.
CREATE TEMP TABLE "routing_rule_conversions" AS
WITH "conditions" AS (
  SELECT r."id",
    count(*) FILTER (WHERE c ? 'rules') AS "groups",
    count(*) FILTER (WHERE c->>'field' = 'team') AS "teams",
    count(*) FILTER (WHERE c->>'field' = 'team' AND c->>'operator' = '='
      AND jsonb_typeof(c->'value') = 'string' AND btrim(c->>'value') <> '') AS "team_equals",
    count(*) FILTER (WHERE c->>'field' = 'project') AS "projects",
    count(*) FILTER (WHERE c->>'field' = 'project' AND (
      (c->>'operator' = '=' AND jsonb_typeof(c->'value') = 'string' AND btrim(c->>'value') <> '')
      OR c->>'operator' = 'null')) AS "project_convertible",
    count(*) FILTER (WHERE c->>'field' = 'labels') AS "label_tests",
    count(*) FILTER (WHERE c->>'field' = 'labels' AND c->>'operator' = 'containsAny'
      AND jsonb_typeof(c->'value') = 'array' AND jsonb_array_length(c->'value') > 0
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(c->'value') l
        WHERE jsonb_typeof(l) <> 'string' OR btrim(l #>> '{}') = ''
      )) AS "labels_convertible",
    count(*) FILTER (WHERE c->>'field' NOT IN ('team', 'project', 'labels')) AS "others",
    max(c->>'value') FILTER (WHERE c->>'field' = 'team') AS "team",
    max(c->>'value') FILTER (WHERE c->>'field' = 'project' AND c->>'operator' = '=') AS "project",
    bool_or(c->>'field' = 'project' AND c->>'operator' = 'null') AS "without_project",
    (array_agg(c->'value') FILTER (WHERE c->>'field' = 'labels'))[1] AS "labels"
  FROM "routing_rules" r
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(r."query"->'rules') = 'array' THEN r."query"->'rules' ELSE '[]'::jsonb END
  ) c
  GROUP BY r."id"
)
SELECT r."id", r."organization_id", r."repository_id",
  coalesce(
    r."query"->>'combinator' = 'and'
      AND (r."query"->'not' IS NULL OR r."query"->'not' = 'false'::jsonb)
      AND c."groups" = 0 AND c."others" = 0
      AND c."teams" = 1 AND c."team_equals" = 1
      AND c."projects" <= 1 AND c."projects" = c."project_convertible"
      AND c."label_tests" <= 1 AND c."label_tests" = c."labels_convertible"
      AND NOT EXISTS (
        SELECT 1 FROM "routing_rules" o WHERE o."repository_id" = r."repository_id" AND o."id" <> r."id"
      )
      AND NOT EXISTS (SELECT 1 FROM "work_item_matches" m WHERE m."repository_id" = r."repository_id"),
    false
  ) AS "convertible",
  c."team",
  c."project",
  coalesce(c."without_project", false) AS "without_project",
  CASE WHEN c."labels" IS NULL THEN '{}'::text[]
    ELSE ARRAY(SELECT jsonb_array_elements_text(c."labels")) END AS "labels"
FROM "routing_rules" r
LEFT JOIN "conditions" c ON c."id" = r."id";
--> statement-breakpoint
-- The matches an organization would have: its existing ones plus a converted rule's.
CREATE TEMP TABLE "routing_rule_candidate_matches" AS
SELECT "organization_id", "repository_id", "team", "project", "without_project", "labels"
FROM "routing_rule_conversions" WHERE "convertible"
UNION ALL
SELECT m."organization_id", m."repository_id", m."team", m."project", m."without_project", m."labels"
FROM "work_item_matches" m
WHERE m."tracker" = 'linear'
  AND m."organization_id" IN (SELECT "organization_id" FROM "routing_rule_conversions");
--> statement-breakpoint
CREATE TEMP TABLE "routing_rule_converted_organizations" AS
SELECT o."organization_id"
FROM (SELECT DISTINCT "organization_id" FROM "routing_rule_conversions") o
WHERE NOT EXISTS (
    SELECT 1 FROM "routing_rule_conversions" r
    WHERE r."organization_id" = o."organization_id" AND NOT r."convertible"
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "routing_rule_candidate_matches" a
    JOIN "routing_rule_candidate_matches" b
      ON b."organization_id" = a."organization_id" AND b."repository_id" > a."repository_id"
    WHERE a."organization_id" = o."organization_id"
      AND lower(a."team") = lower(b."team")
      AND a."without_project" = b."without_project"
      AND lower(a."project") IS NOT DISTINCT FROM lower(b."project")
      AND (
        (cardinality(a."labels") = 0 AND cardinality(b."labels") = 0)
        OR EXISTS (
          SELECT 1 FROM unnest(a."labels") la JOIN unnest(b."labels") lb ON lower(la) = lower(lb)
        )
      )
  );
--> statement-breakpoint
DO $$
DECLARE
  kept text;
BEGIN
  SELECT string_agg(DISTINCT format('organization %s', r."organization_id"), ', ')
  INTO kept
  FROM "routing_rule_conversions" r
  WHERE r."organization_id" NOT IN (SELECT "organization_id" FROM "routing_rule_converted_organizations");
  IF kept IS NOT NULL THEN
    RAISE NOTICE 'Routing rules kept (they don''t all convert into work item matches without overlap): %', kept;
  END IF;
END $$;
--> statement-breakpoint
INSERT INTO "work_item_matches" ("repository_id", "organization_id", "tracker", "team", "project", "without_project", "labels")
SELECT r."repository_id", r."organization_id", 'linear', r."team", r."project", r."without_project", r."labels"
FROM "routing_rule_conversions" r
WHERE r."organization_id" IN (SELECT "organization_id" FROM "routing_rule_converted_organizations");
--> statement-breakpoint
DELETE FROM "routing_rules"
WHERE "organization_id" IN (SELECT "organization_id" FROM "routing_rule_converted_organizations");
--> statement-breakpoint
DROP TABLE "routing_rule_converted_organizations", "routing_rule_candidate_matches", "routing_rule_conversions";
