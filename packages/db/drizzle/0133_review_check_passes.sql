ALTER TABLE "reviews" ADD COLUMN "check_type" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "dropped_findings" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "passes" jsonb DEFAULT '[]'::jsonb NOT NULL;