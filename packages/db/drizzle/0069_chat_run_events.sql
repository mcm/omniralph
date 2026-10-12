CREATE TYPE "public"."chat_run_event_kind" AS ENUM('response', 'question', 'permission_request', 'completion', 'failure', 'cleanup_question');--> statement-breakpoint
CREATE TABLE "chat_run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"thread_run_id" uuid NOT NULL,
	"kind" "chat_run_event_kind" NOT NULL,
	"body" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_run_events" ADD CONSTRAINT "chat_run_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_run_events" ADD CONSTRAINT "chat_run_events_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_run_events" ADD CONSTRAINT "chat_run_events_thread_run_id_chat_thread_runs_id_fk" FOREIGN KEY ("thread_run_id") REFERENCES "public"."chat_thread_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_run_events_idempotency_key_uq" ON "chat_run_events" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "chat_run_events_chat_thread_id_created_at_idx" ON "chat_run_events" USING btree ("chat_thread_id","created_at");