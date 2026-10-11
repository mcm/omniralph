ALTER TABLE "review_runs" ADD COLUMN "summary_comment_id" text;--> statement-breakpoint
ALTER TABLE "review_runs" ADD COLUMN "pr_author" text;--> statement-breakpoint
ALTER TABLE "review_runs" ADD COLUMN "profile_name" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "scope" jsonb;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "fixed_finding_ids" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
-- Review runs whose reviews were already posted one by one aren't posted again.
UPDATE "review_runs" SET "summary_comment_id" = (SELECT "reviews"."summary_comment_id" FROM "reviews" WHERE "reviews"."review_run_id" = "review_runs"."id" AND "reviews"."summary_comment_id" IS NOT NULL ORDER BY "reviews"."created_at" LIMIT 1);
