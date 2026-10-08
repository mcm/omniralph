ALTER TABLE "agents" ADD COLUMN "update_request_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "update_request_version" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "update_requested_at" timestamp with time zone;