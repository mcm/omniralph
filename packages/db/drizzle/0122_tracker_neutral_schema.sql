-- Tracker-neutral names for the Linear-named tables, columns, indexes and enums.
-- Renames only, so every row is kept; the provider value 'linear' stays.
ALTER TYPE "public"."chat_linear_issue_draft_status" RENAME TO "chat_tracker_issue_draft_status";
--> statement-breakpoint
ALTER TABLE "chat_linear_issue_drafts" RENAME TO "chat_tracker_issue_drafts";
--> statement-breakpoint
ALTER TABLE "chat_tracker_issue_drafts" RENAME CONSTRAINT "chat_linear_issue_drafts_pkey" TO "chat_tracker_issue_drafts_pkey";
--> statement-breakpoint
ALTER TABLE "chat_tracker_issue_drafts" RENAME CONSTRAINT "chat_linear_issue_drafts_thread_id_chat_threads_id_fk" TO "chat_tracker_issue_drafts_thread_id_chat_threads_id_fk";
--> statement-breakpoint
ALTER TABLE "chat_tracker_issue_drafts" RENAME CONSTRAINT "chat_linear_issue_drafts_requested_by_user_id_users_id_fk" TO "chat_tracker_issue_drafts_requested_by_user_id_users_id_fk";
--> statement-breakpoint
ALTER INDEX "chat_linear_issue_drafts_thread_id_idx" RENAME TO "chat_tracker_issue_drafts_thread_id_idx";
--> statement-breakpoint
ALTER TABLE "chat_tracker_issue_drafts" RENAME COLUMN "linear_issue_id" TO "tracker_issue_id";
--> statement-breakpoint
ALTER TABLE "chat_tracker_issue_drafts" RENAME COLUMN "linear_issue_identifier" TO "tracker_issue_identifier";
--> statement-breakpoint
ALTER TABLE "chat_tracker_issue_drafts" RENAME COLUMN "linear_issue_url" TO "tracker_issue_url";
--> statement-breakpoint
ALTER TABLE "chat_tracker_issue_drafts" ADD COLUMN "tracker_provider" "integration_provider" DEFAULT 'linear' NOT NULL;
--> statement-breakpoint
ALTER TABLE "chat_linear_delegations" RENAME TO "chat_tracker_delegations";
--> statement-breakpoint
ALTER TABLE "chat_tracker_delegations" RENAME CONSTRAINT "chat_linear_delegations_pkey" TO "chat_tracker_delegations_pkey";
--> statement-breakpoint
ALTER TABLE "chat_tracker_delegations" RENAME CONSTRAINT "chat_linear_delegations_organization_id_organizations_id_fk" TO "chat_tracker_delegations_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "chat_tracker_delegations" RENAME CONSTRAINT "chat_linear_delegations_thread_id_chat_threads_id_fk" TO "chat_tracker_delegations_thread_id_chat_threads_id_fk";
--> statement-breakpoint
ALTER INDEX "chat_linear_delegations_issue_idx" RENAME TO "chat_tracker_delegations_issue_idx";
--> statement-breakpoint
ALTER INDEX "chat_linear_delegations_created_at_idx" RENAME TO "chat_tracker_delegations_created_at_idx";
--> statement-breakpoint
ALTER TABLE "chat_tracker_delegations" RENAME COLUMN "linear_issue_id" TO "tracker_issue_id";
--> statement-breakpoint
ALTER TABLE "chat_tracker_delegations" ADD COLUMN "tracker_provider" "integration_provider" DEFAULT 'linear' NOT NULL;
--> statement-breakpoint
ALTER TABLE "ralph_runs" RENAME COLUMN "linear_issue_id" TO "tracker_issue_id";
--> statement-breakpoint
ALTER TABLE "ralph_runs" RENAME COLUMN "linear_identifier" TO "tracker_identifier";
--> statement-breakpoint
ALTER TABLE "ralph_runs" RENAME COLUMN "linear_title" TO "tracker_title";
--> statement-breakpoint
ALTER TABLE "ralph_runs" RENAME COLUMN "linear_url" TO "tracker_url";
--> statement-breakpoint
ALTER TABLE "ralph_runs" RENAME COLUMN "linear_agent_session_id" TO "tracker_session_id";
--> statement-breakpoint
ALTER INDEX "ralph_runs_linear_issue_id_idx" RENAME TO "ralph_runs_tracker_issue_id_idx";
--> statement-breakpoint
ALTER TABLE "ralph_runs" ADD COLUMN "tracker_provider" "integration_provider" DEFAULT 'linear' NOT NULL;
--> statement-breakpoint
-- The origin 'linear' becomes 'tracker'. Renaming the value keeps the rows; the
-- check constraint and the partial index are rewritten to the new names.
ALTER TABLE "ralph_runs" DROP CONSTRAINT "ralph_runs_origin_check";
--> statement-breakpoint
DROP INDEX "ralph_runs_issue_active_uq";
--> statement-breakpoint
ALTER TYPE "public"."ralph_run_origin" RENAME VALUE 'linear' TO 'tracker';
--> statement-breakpoint
ALTER TABLE "ralph_runs" ALTER COLUMN "origin" SET DEFAULT 'tracker';
--> statement-breakpoint
CREATE UNIQUE INDEX "ralph_runs_issue_active_uq" ON "ralph_runs" USING btree ("organization_id","tracker_issue_id") WHERE origin = 'tracker' and status in ('pending', 'running', 'waiting');
--> statement-breakpoint
ALTER TABLE "ralph_runs" ADD CONSTRAINT "ralph_runs_origin_check" CHECK ((origin = 'tracker' and tracker_issue_id is not null and tracker_identifier is not null and tracker_session_id is not null)
        or (origin = 'chat' and mode = 'request'));
--> statement-breakpoint
ALTER TABLE "ralph_stories" RENAME COLUMN "linear_issue_id" TO "tracker_issue_id";
--> statement-breakpoint
ALTER TABLE "ralph_stories" ADD COLUMN "tracker_provider" "integration_provider" DEFAULT 'linear' NOT NULL;
--> statement-breakpoint
ALTER TABLE "triage_runs" RENAME COLUMN "linear_issue_id" TO "tracker_issue_id";
--> statement-breakpoint
ALTER TABLE "triage_runs" RENAME COLUMN "linear_agent_session_id" TO "tracker_session_id";
--> statement-breakpoint
ALTER TABLE "triage_runs" ADD COLUMN "tracker_provider" "integration_provider" DEFAULT 'linear' NOT NULL;
--> statement-breakpoint
-- Stored web chat cards of the work item draft.
UPDATE "chat_web_messages"
  SET "card_ref" = jsonb_set("card_ref", '{kind}', '"tracker_issue_draft"')
  WHERE "card_ref" ->> 'kind' = 'linear_issue_draft';
