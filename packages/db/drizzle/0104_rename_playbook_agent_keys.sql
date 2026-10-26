-- Renames the harness-named keys of stored playbooks and run specs (after 0103): a `tools`
--> statement-breakpoint
-- object's `harness` becomes `agent`, and a playbook's `requirements.minHarnessVersion`
--> statement-breakpoint
-- becomes `minAgentVersion`. Every other value is kept, so pending jobs parse under the agent.
--> statement-breakpoint
CREATE FUNCTION "pg_temp"."agent_tools_keys"(j jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  result jsonb;
BEGIN
  IF jsonb_typeof(j) = 'object' THEN
    SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) INTO result
    FROM (
      SELECT t.key,
        CASE
          WHEN t.key = 'tools' AND jsonb_typeof(t.value) = 'object' AND t.value ? 'harness'
            THEN (t.value - 'harness') || jsonb_build_object('agent', coalesce(t.value -> 'agent', t.value -> 'harness'))
          ELSE t.value
        END AS value
      FROM (
        SELECT o.key, "pg_temp"."agent_tools_keys"(o.value) AS value FROM jsonb_each(j) AS o
      ) AS t
    ) AS e;
    RETURN result;
  ELSIF jsonb_typeof(j) = 'array' THEN
    SELECT coalesce(jsonb_agg("pg_temp"."agent_tools_keys"(a.value) ORDER BY a.ordinality), '[]'::jsonb) INTO result
    FROM jsonb_array_elements(j) WITH ORDINALITY AS a(value, ordinality);
    RETURN result;
  END IF;
  RETURN j;
END
$$;
--> statement-breakpoint
UPDATE "playbooks" SET "definition" = "pg_temp"."agent_tools_keys"("definition")
  WHERE "definition"::text LIKE '%"harness"%';
--> statement-breakpoint
UPDATE "playbooks" SET "requirements" = ("requirements" - 'minHarnessVersion')
    || jsonb_build_object('minAgentVersion', coalesce("requirements" -> 'minAgentVersion', "requirements" -> 'minHarnessVersion'))
  WHERE jsonb_typeof("requirements") = 'object' AND "requirements" ? 'minHarnessVersion';
--> statement-breakpoint
UPDATE "jobs" SET "payload" = "pg_temp"."agent_tools_keys"("payload")
  WHERE "payload"::text LIKE '%"harness"%';
--> statement-breakpoint
DROP FUNCTION "pg_temp"."agent_tools_keys"(jsonb);
