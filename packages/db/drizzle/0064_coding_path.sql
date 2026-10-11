CREATE TYPE "public"."ralph_message_trigger" AS ENUM('linear.mention', 'chat.request', 'pr.review-findings', 'pr.ci-failed', 'pr.fix-command');--> statement-breakpoint
CREATE TYPE "public"."repository_coding_path" AS ENUM('legacy', 'tasks');--> statement-breakpoint
ALTER TABLE "ralph_messages" ADD COLUMN "trigger" "ralph_message_trigger";--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "coding_path" "repository_coding_path" DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "story_task_id" text DEFAULT 'builtin:implement-story' NOT NULL;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "request_task_id" text DEFAULT 'builtin:handle-request' NOT NULL;