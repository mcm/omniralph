-- Legacy `review.run` jobs (no task, a `ReviewJobPayload`) no longer run: no harness handles them.
-- Fail the reviews of the active ones and cancel the jobs; a new push or `@bot review` re-reviews.
UPDATE "reviews" SET "status" = 'failed', "error" = 'Canceled: legacy review jobs no longer run. Re-run the review.', "updated_at" = now()
WHERE "status" IN ('queued', 'running')
  AND "id"::text IN (
    SELECT "payload"->>'reviewId' FROM "jobs"
    WHERE "type" = 'review.run' AND "task_id" IS NULL AND "status" IN ('queued', 'running')
  );--> statement-breakpoint
UPDATE "jobs" SET "status" = 'canceled', "cancel_requested" = true, "error" = 'Legacy review jobs no longer run.', "finished_at" = now()
WHERE "type" = 'review.run' AND "task_id" IS NULL AND "status" IN ('queued', 'running');--> statement-breakpoint
-- Review task runs (`builtin:review-pr` and the other review tasks) are `review.task` jobs.
UPDATE "jobs" SET "type" = 'review.task' WHERE "type" = 'review.run' AND "task_id" IS NOT NULL;
