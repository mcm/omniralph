ALTER TABLE "ralph_messages" ADD COLUMN "ship" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ralph_runs" ADD COLUMN "permission" jsonb;