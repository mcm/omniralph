CREATE TYPE "public"."chat_linear_issue_draft_status" AS ENUM('pending', 'creating', 'created', 'cancelled', 'expired');--> statement-breakpoint
CREATE TABLE "chat_linear_issue_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"requested_by_user_id" text NOT NULL,
	"requested_by_external_user_id" text NOT NULL,
	"team_id" text NOT NULL,
	"team_key" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"project_name" text,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"priority" integer,
	"status" "chat_linear_issue_draft_status" DEFAULT 'pending' NOT NULL,
	"external_message_id" text,
	"linear_issue_id" text,
	"linear_issue_identifier" text,
	"linear_issue_url" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_linear_issue_drafts" ADD CONSTRAINT "chat_linear_issue_drafts_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_linear_issue_drafts" ADD CONSTRAINT "chat_linear_issue_drafts_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_linear_issue_drafts_thread_id_idx" ON "chat_linear_issue_drafts" USING btree ("thread_id");