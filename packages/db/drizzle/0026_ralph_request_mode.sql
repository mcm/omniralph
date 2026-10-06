CREATE TYPE "public"."ralph_run_mode" AS ENUM('epic', 'request');--> statement-breakpoint
ALTER TABLE "ralph_runs" ADD COLUMN "mode" "ralph_run_mode" DEFAULT 'epic' NOT NULL;--> statement-breakpoint
ALTER TABLE "ralph_runs" ADD COLUMN "request_job_id" uuid;--> statement-breakpoint
ALTER TABLE "ralph_runs" ADD COLUMN "request_output" text;--> statement-breakpoint
ALTER TABLE "ralph_runs" ADD CONSTRAINT "ralph_runs_request_job_id_jobs_id_fk" FOREIGN KEY ("request_job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ralph_lanes" DROP COLUMN "pending_requests";