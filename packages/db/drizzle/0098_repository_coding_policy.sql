-- A repo's coding policy shrinks to columns; everything else ralph_settings held moves to the
-- story and request playbooks (or the organization's tracker labels), whose built-ins carry
-- today's defaults. Converting would lose a value that differs from them, so stop and name the
-- repo and key instead. A key a row doesn't have is its default.
DO $$
DECLARE
  offending text;
BEGIN
  SELECT string_agg(format('repository %s (%s) key %s', r."id", r."full_path", d."key"), ', ' ORDER BY r."full_path", r."id", d."key")
  INTO offending
  FROM "repositories" r
  CROSS JOIN (VALUES
    ('verifyCommands', '[]'::jsonb),
    ('runPrdQualityGates', 'true'::jsonb),
    ('allowedTools', 'null'::jsonb),
    ('disallowedTools', 'null'::jsonb),
    ('model', '"opus"'::jsonb),
    ('fallbackModel', 'null'::jsonb),
    ('allowPreparation', 'true'::jsonb),
    ('manualLabels', '["manual"]'::jsonb),
    ('blockedLabels', '["under-review", "blocked"]'::jsonb),
    ('maxReviewRounds', '3'::jsonb),
    ('maxFixRounds', '3'::jsonb),
    ('cleanupMergedWorktrees', 'true'::jsonb),
    ('unmergedBranchTimeoutMinutes', '60'::jsonb),
    ('epicCompletedState', 'null'::jsonb),
    ('setupCommand', 'null'::jsonb)
  ) AS d("key", "value")
  WHERE r."ralph_settings" ? d."key"
    AND r."ralph_settings" -> d."key" IS DISTINCT FROM d."value";
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'Repo coding settings differ from the defaults and would be lost: %', offending
      USING HINT = 'Reset them to the defaults (or move them into a custom story or request playbook by hand), then migrate again.';
  END IF;
END $$;--> statement-breakpoint
CREATE TYPE "public"."history_rewrite" AS ENUM('when-asked', 'always', 'never');--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "coding_instructions" text;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "open_pull_request_early" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "history_rewrite" "history_rewrite" DEFAULT 'when-asked' NOT NULL;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "respond_to_reviews_and_ci" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- The kept fields; a missing or malformed value is its default, as ralph read them.
UPDATE "repositories" SET
  "coding_instructions" = CASE WHEN jsonb_typeof("ralph_settings" -> 'appendInstruction') = 'string'
    THEN NULLIF(btrim("ralph_settings" ->> 'appendInstruction'), '') END,
  "open_pull_request_early" = CASE WHEN jsonb_typeof("ralph_settings" -> 'openPullRequestEarly') = 'boolean'
    THEN ("ralph_settings" -> 'openPullRequestEarly')::boolean ELSE false END,
  "history_rewrite" = CASE WHEN "ralph_settings" ->> 'historyRewrite' IN ('when-asked', 'always', 'never')
    THEN ("ralph_settings" ->> 'historyRewrite')::"history_rewrite" ELSE 'when-asked' END,
  -- One switch for both: on when either was.
  "respond_to_reviews_and_ci" =
    (CASE WHEN jsonb_typeof("ralph_settings" -> 'respondToReviews') = 'boolean'
      THEN ("ralph_settings" -> 'respondToReviews')::boolean ELSE true END)
    OR (CASE WHEN jsonb_typeof("ralph_settings" -> 'respondToCiFailures') = 'boolean'
      THEN ("ralph_settings" -> 'respondToCiFailures')::boolean ELSE true END);--> statement-breakpoint
ALTER TABLE "repositories" DROP COLUMN "ralph_settings";
