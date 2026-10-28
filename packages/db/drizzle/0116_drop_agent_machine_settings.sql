-- An agent's slots, pool limits, host tool paths and version pin now live in its own
-- settings.json and reach the control panel only through the heartbeat (reported_*). No value
-- stored here can reach a machine's settings.json, so dropping a set one would silently change
-- that machine's behavior: stop and name each one instead. Soft-deleted agents aren't checked.
DO $$
DECLARE
  offending text;
BEGIN
  SELECT string_agg(item, ', ' ORDER BY ord, item)
  INTO offending
  FROM (
    SELECT 1 AS ord, format('agent %s max_concurrency', a."id") AS item
    FROM "agents" a WHERE a."deleted_at" IS NULL AND a."max_concurrency" IS NOT NULL
    UNION ALL
    SELECT 1, format('agent %s pool_limits', a."id")
    FROM "agents" a WHERE a."deleted_at" IS NULL AND a."pool_limits" <> '{}'::jsonb
    UNION ALL
    SELECT 1, format('agent %s desired_version', a."id")
    FROM "agents" a WHERE a."deleted_at" IS NULL AND a."desired_version" IS NOT NULL
    UNION ALL
    SELECT 1, format('agent %s update_request_id', a."id")
    FROM "agents" a WHERE a."deleted_at" IS NULL AND a."update_request_id" IS NOT NULL
    UNION ALL
    SELECT 2, 'table host_tools' WHERE EXISTS (SELECT 1 FROM "host_tools")
    UNION ALL
    SELECT 2, 'table agent_host_tools' WHERE EXISTS (SELECT 1 FROM "agent_host_tools")
    UNION ALL
    SELECT 3, format('app_settings agent.maxConcurrency (organization %s)', s."organization_id")
    FROM "app_settings" s WHERE s."key" = 'agent.maxConcurrency'
  ) found;
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'Set these on the agent''s page first: %', offending
      USING HINT = 'Each agent''s settings.json is now the only source of these values. Set them on the agent''s page (or in settings.json), clear them here, then migrate again.';
  END IF;
END $$;--> statement-breakpoint
DROP TABLE "agent_host_tools" CASCADE;--> statement-breakpoint
DROP TABLE "host_tools" CASCADE;--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "max_concurrency";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "pool_limits";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "desired_version";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "update_request_id";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "update_request_version";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "update_requested_at";--> statement-breakpoint
DELETE FROM "app_settings" WHERE "key" = 'agent.maxConcurrency';
