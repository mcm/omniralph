CREATE TYPE "public"."pr_review_state" AS ENUM('none', 'review_requested', 'commented', 'changes_requested', 'approved');--> statement-breakpoint
ALTER TABLE "ralph_lanes" ADD COLUMN "pr_draft" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ralph_lanes" ADD COLUMN "pr_review_state" "pr_review_state" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "ralph_lanes" ADD COLUMN "pr_state_updated_at" timestamp with time zone;