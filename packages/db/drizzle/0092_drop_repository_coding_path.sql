ALTER TABLE "repositories" DROP COLUMN "coding_path";--> statement-breakpoint
DROP TYPE "public"."repository_coding_path";--> statement-breakpoint
-- Legacy `ralph.story`, `ralph.request` and `ralph.describe-pr` jobs (no task) no longer run: no agent handles them.
-- Cancel the active ones; the reconcile cron advances their runs, which enqueue coding and query runs instead.
UPDATE "jobs" SET "status" = 'canceled', "cancel_requested" = true, "error" = 'Legacy coding jobs no longer run.', "finished_at" = now()
WHERE "type" IN ('ralph.story', 'ralph.request', 'ralph.describe-pr') AND "task_id" IS NULL AND "status" IN ('queued', 'running');
