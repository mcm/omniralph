CREATE TYPE "public"."review_run_status" AS ENUM('queued', 'running', 'correlating', 'completed', 'failed', 'skipped');--> statement-breakpoint
CREATE TABLE "review_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"base_sha" text NOT NULL,
	"trigger" "review_trigger" NOT NULL,
	"mode" text NOT NULL,
	"profile_id" text,
	"status" "review_run_status" DEFAULT 'queued' NOT NULL,
	"correlation_job_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "review_task_ids" text[] DEFAULT '{builtin:review-pr}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "correlation_task_id" text DEFAULT 'builtin:correlate-findings' NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "review_run_id" uuid;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "task_id" text;--> statement-breakpoint
-- Every review so far ran builtin:review-pr (or its legacy review.run job).
UPDATE "reviews" SET "task_id" = 'builtin:review-pr';--> statement-breakpoint
ALTER TABLE "review_runs" ADD CONSTRAINT "review_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_runs" ADD CONSTRAINT "review_runs_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_runs" ADD CONSTRAINT "review_runs_correlation_job_id_jobs_id_fk" FOREIGN KEY ("correlation_job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_runs_repository_pr_idx" ON "review_runs" USING btree ("repository_id","pr_number");--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_review_run_id_review_runs_id_fk" FOREIGN KEY ("review_run_id") REFERENCES "public"."review_runs"("id") ON DELETE cascade ON UPDATE no action;