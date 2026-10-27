CREATE TYPE "public"."chat_request_draft_status" AS ENUM('pending', 'starting', 'started', 'adding', 'added', 'dismissed', 'expired');--> statement-breakpoint
CREATE TABLE "chat_request_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"requested_by_user_id" text NOT NULL,
	"requested_by_external_user_id" text NOT NULL,
	"repository_id" uuid NOT NULL,
	"title" text NOT NULL,
	"request" text NOT NULL,
	"status" "chat_request_draft_status" DEFAULT 'pending' NOT NULL,
	"triage_now" boolean,
	"error" text,
	"ralph_run_id" uuid,
	"work_item_tracker" text,
	"work_item_external_id" text,
	"work_item_identifier" text,
	"work_item_url" text,
	"message_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_request_drafts" ADD CONSTRAINT "chat_request_drafts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_request_drafts" ADD CONSTRAINT "chat_request_drafts_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_request_drafts" ADD CONSTRAINT "chat_request_drafts_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_request_drafts" ADD CONSTRAINT "chat_request_drafts_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_request_drafts" ADD CONSTRAINT "chat_request_drafts_ralph_run_id_ralph_runs_id_fk" FOREIGN KEY ("ralph_run_id") REFERENCES "public"."ralph_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_request_drafts_thread_id_idx" ON "chat_request_drafts" USING btree ("thread_id");