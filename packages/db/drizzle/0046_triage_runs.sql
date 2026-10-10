CREATE TYPE "public"."triage_run_status" AS ENUM('queued', 'running', 'completed', 'failed', 'stopped');--> statement-breakpoint
CREATE TYPE "public"."triage_run_trigger" AS ENUM('mention', 'label');--> statement-breakpoint
CREATE TABLE "triage_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"linear_issue_id" text NOT NULL,
	"linear_agent_session_id" text NOT NULL,
	"trigger" "triage_run_trigger" NOT NULL,
	"current_job_id" uuid,
	"status" "triage_run_status" DEFAULT 'queued' NOT NULL,
	"last_result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "triage_runs" ADD CONSTRAINT "triage_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triage_runs" ADD CONSTRAINT "triage_runs_current_job_id_jobs_id_fk" FOREIGN KEY ("current_job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "triage_runs_agent_session_uq" ON "triage_runs" USING btree ("linear_agent_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "triage_runs_issue_active_uq" ON "triage_runs" USING btree ("organization_id","linear_issue_id") WHERE status in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "triage_runs_organization_created_at_idx" ON "triage_runs" USING btree ("organization_id","created_at");