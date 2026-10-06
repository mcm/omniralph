CREATE TYPE "public"."ralph_message_kind" AS ENUM('guidance', 'request');--> statement-breakpoint
CREATE TABLE "ralph_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"lane_id" uuid,
	"job_id" uuid,
	"kind" "ralph_message_kind" NOT NULL,
	"text" text NOT NULL,
	"author" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ralph_messages" ADD CONSTRAINT "ralph_messages_run_id_ralph_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ralph_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ralph_messages" ADD CONSTRAINT "ralph_messages_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ralph_messages_run_id_idx" ON "ralph_messages" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "ralph_messages_job_id_idx" ON "ralph_messages" USING btree ("job_id");