ALTER TYPE "public"."ralph_run_origin" ADD VALUE 'pull-request';--> statement-breakpoint
ALTER TABLE "ralph_runs" DROP CONSTRAINT "ralph_runs_origin_check";--> statement-breakpoint
ALTER TABLE "ralph_runs" ADD CONSTRAINT "ralph_runs_origin_check" CHECK ((origin = 'tracker' and tracker_issue_id is not null and tracker_identifier is not null and tracker_session_id is not null)
        or (origin <> 'tracker' and mode = 'request'));