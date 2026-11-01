-- Renames the Linear trigger kinds to their tracker names: `linear.delegated`, `linear.triage`
-- and `linear.mention` become `tracker.delegated`, `tracker.triage` and `tracker.mention`.
-- Requests keep their trigger (the enum value is renamed in place) and stored job payloads
-- get the new `trigger.kind`. Custom playbooks take their triggers from their role, but any
-- definition still naming a Linear trigger kind is rewritten too.
ALTER TYPE "public"."ralph_message_trigger" RENAME VALUE 'linear.mention' TO 'tracker.mention';
--> statement-breakpoint
UPDATE "jobs" SET "payload" = jsonb_set(
    "payload",
    '{trigger,kind}',
    to_jsonb('tracker.' || substring("payload" -> 'trigger' ->> 'kind' from 8))
  )
  WHERE jsonb_typeof("payload" -> 'trigger') = 'object'
    AND "payload" -> 'trigger' ->> 'kind' IN ('linear.delegated', 'linear.triage', 'linear.mention');
--> statement-breakpoint
UPDATE "playbooks" SET "definition" = regexp_replace(
    "definition"::text,
    '"linear\.(delegated|triage|mention)"',
    '"tracker.\1"',
    'g'
  )::jsonb
  WHERE "definition"::text ~ '"linear\.(delegated|triage|mention)"';
