ALTER TABLE "ralph_stories" ADD COLUMN "rounds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ralph_stories" ADD COLUMN "round_metrics" jsonb;