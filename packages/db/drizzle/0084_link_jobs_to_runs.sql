ALTER TABLE "jobs" ADD COLUMN "ralph_story_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "review_run_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "triage_run_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "chat_thread_run_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_ralph_story_id_ralph_stories_id_fk" FOREIGN KEY ("ralph_story_id") REFERENCES "public"."ralph_stories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_review_run_id_review_runs_id_fk" FOREIGN KEY ("review_run_id") REFERENCES "public"."review_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_triage_run_id_triage_runs_id_fk" FOREIGN KEY ("triage_run_id") REFERENCES "public"."triage_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_chat_thread_run_id_chat_thread_runs_id_fk" FOREIGN KEY ("chat_thread_run_id") REFERENCES "public"."chat_thread_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_ralph_story_id_idx" ON "jobs" USING btree ("ralph_story_id");--> statement-breakpoint
CREATE INDEX "jobs_review_run_id_idx" ON "jobs" USING btree ("review_run_id");--> statement-breakpoint
CREATE INDEX "jobs_triage_run_id_idx" ON "jobs" USING btree ("triage_run_id");--> statement-breakpoint
CREATE INDEX "jobs_chat_thread_run_id_idx" ON "jobs" USING btree ("chat_thread_run_id");--> statement-breakpoint
-- Every review belongs to a review run: a legacy review (from before review runs) gets a run of
-- its own, which takes the review's ID, so the review and its jobs can be linked to it below.
INSERT INTO "review_runs" ("id", "organization_id", "repository_id", "pr_number", "head_sha", "base_sha", "trigger", "mode", "profile_id", "status", "error", "created_at", "updated_at")
SELECT r."id", repo."organization_id", r."repository_id", r."pr_number", r."head_sha", r."base_sha", r."trigger", 'incremental', r."profile_id",
  (CASE r."status" WHEN 'budget_exhausted' THEN 'failed' ELSE r."status"::text END)::"review_run_status",
  r."error", r."created_at", r."updated_at"
FROM "reviews" r
JOIN "repositories" repo ON repo."id" = r."repository_id"
WHERE r."review_run_id" IS NULL;--> statement-breakpoint
UPDATE "reviews" SET "review_run_id" = "id" WHERE "review_run_id" IS NULL;--> statement-breakpoint
-- Review task jobs (and legacy `review.run` jobs, whose payload is `{reviewId}`) by their review.
UPDATE "jobs" j SET "review_run_id" = r."review_run_id"
FROM "reviews" r
WHERE j."type" IN ('review.task', 'review.run')
  AND r."id"::text = coalesce(j."payload"->'trigger'->'context'->>'reviewId', j."payload"->>'reviewId');--> statement-breakpoint
UPDATE "jobs" j SET "review_run_id" = rr."id"
FROM "review_runs" rr
WHERE rr."correlation_job_id" = j."id";--> statement-breakpoint
UPDATE "jobs" j SET "triage_run_id" = t."id"
FROM "triage_runs" t
WHERE j."type" = 'triage.run'
  AND t."id"::text = j."payload"->'trigger'->'context'->>'triageRunId';--> statement-breakpoint
UPDATE "jobs" j SET "chat_thread_run_id" = c."id"
FROM "chat_thread_runs" c
WHERE c."kind" = 'query' AND c."job_id" = j."id";--> statement-breakpoint
-- A story job's story: `storyId` in a legacy job's payload, in a coding run's trigger context.
UPDATE "jobs" j SET "ralph_story_id" = s."id"
FROM "ralph_stories" s
WHERE j."type" = 'ralph.story'
  AND s."id"::text = coalesce(j."payload"->>'storyId', j."payload"->'trigger'->'context'->>'storyId');
