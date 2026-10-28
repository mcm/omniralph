ALTER TABLE "agents" ADD COLUMN "reported_max_concurrency" integer;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "reported_pool_limits" jsonb;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "reported_version_pin" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "reported_installables_allow" text[];