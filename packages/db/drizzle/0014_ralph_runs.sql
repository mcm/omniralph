CREATE TYPE "public"."ralph_run_kind" AS ENUM('children', 'prd', 'single');--> statement-breakpoint
CREATE TYPE "public"."ralph_run_status" AS ENUM('pending', 'running', 'waiting', 'completed', 'failed', 'stopped');--> statement-breakpoint
CREATE TYPE "public"."ralph_story_status" AS ENUM('pending', 'running', 'completed', 'blocked', 'exhausted', 'manual');--> statement-breakpoint
CREATE TABLE "ralph_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"linear_issue_id" text NOT NULL,
	"linear_identifier" text NOT NULL,
	"linear_agent_session_id" text NOT NULL,
	"kind" "ralph_run_kind" NOT NULL,
	"focus_story_id" text,
	"repository_id" uuid NOT NULL,
	"branch" text NOT NULL,
	"base_branch" text NOT NULL,
	"agent_id" uuid,
	"pr_number" integer,
	"pr_url" text,
	"status" "ralph_run_status" DEFAULT 'pending' NOT NULL,
	"waiting_on" jsonb,
	"guidance" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ignore_blockers" boolean DEFAULT false NOT NULL,
	"progress" text DEFAULT '' NOT NULL,
	"pending_elicitation" jsonb,
	"preparation" jsonb,
	"iterations" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ralph_stories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"linear_issue_id" text NOT NULL,
	"identifier" text NOT NULL,
	"title" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"status" "ralph_story_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_feedback" text,
	"commit_sha" text,
	"last_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "ralph_run_id" uuid;--> statement-breakpoint
ALTER TABLE "ralph_runs" ADD CONSTRAINT "ralph_runs_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ralph_runs" ADD CONSTRAINT "ralph_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ralph_stories" ADD CONSTRAINT "ralph_stories_run_id_ralph_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ralph_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ralph_stories" ADD CONSTRAINT "ralph_stories_last_job_id_jobs_id_fk" FOREIGN KEY ("last_job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ralph_runs_agent_session_uq" ON "ralph_runs" USING btree ("linear_agent_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ralph_runs_issue_active_uq" ON "ralph_runs" USING btree ("linear_issue_id") WHERE status in ('pending', 'running', 'waiting');--> statement-breakpoint
CREATE INDEX "ralph_runs_linear_issue_id_idx" ON "ralph_runs" USING btree ("linear_issue_id","created_at");--> statement-breakpoint
CREATE INDEX "ralph_runs_status_created_at_idx" ON "ralph_runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "ralph_runs_repository_created_at_idx" ON "ralph_runs" USING btree ("repository_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ralph_stories_run_issue_uq" ON "ralph_stories" USING btree ("run_id","linear_issue_id");--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_ralph_run_id_ralph_runs_id_fk" FOREIGN KEY ("ralph_run_id") REFERENCES "public"."ralph_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_ralph_run_id_idx" ON "jobs" USING btree ("ralph_run_id");