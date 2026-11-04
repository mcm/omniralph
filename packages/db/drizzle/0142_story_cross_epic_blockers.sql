ALTER TABLE "ralph_stories" ADD COLUMN "cross_epic_blockers" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ralph_stories" ADD COLUMN "rebase_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ralph_stories" ADD COLUMN "rerun_after_cancel" boolean DEFAULT false NOT NULL;