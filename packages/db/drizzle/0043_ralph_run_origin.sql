CREATE TYPE "public"."ralph_run_origin" AS ENUM('linear', 'chat');--> statement-breakpoint
DROP INDEX "ralph_runs_issue_active_uq";--> statement-breakpoint
ALTER TABLE "ralph_runs" ALTER COLUMN "linear_issue_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ralph_runs" ALTER COLUMN "linear_identifier" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ralph_runs" ALTER COLUMN "linear_agent_session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ralph_runs" ADD COLUMN "origin" "ralph_run_origin" DEFAULT 'linear' NOT NULL;--> statement-breakpoint
ALTER TABLE "ralph_runs" ADD COLUMN "chat_thread_id" uuid;--> statement-breakpoint
ALTER TABLE "ralph_runs" ADD CONSTRAINT "ralph_runs_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ralph_runs_chat_thread_active_uq" ON "ralph_runs" USING btree ("chat_thread_id") WHERE origin = 'chat' and status in ('pending', 'running', 'waiting');--> statement-breakpoint
CREATE INDEX "ralph_runs_chat_thread_id_idx" ON "ralph_runs" USING btree ("chat_thread_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ralph_runs_issue_active_uq" ON "ralph_runs" USING btree ("organization_id","linear_issue_id") WHERE origin = 'linear' and status in ('pending', 'running', 'waiting');--> statement-breakpoint
ALTER TABLE "ralph_runs" ADD CONSTRAINT "ralph_runs_origin_check" CHECK ((origin = 'linear' and linear_issue_id is not null and linear_identifier is not null and linear_agent_session_id is not null)
        or (origin = 'chat' and mode = 'request'));