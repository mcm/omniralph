ALTER TYPE "public"."finding_status" ADD VALUE 'merged';--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "source_task_ids" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "merged_into_finding_id" uuid;--> statement-breakpoint
-- Existing findings were reported by their review's task.
UPDATE "findings" SET "source_task_ids" = ARRAY["reviews"."task_id"] FROM "reviews" WHERE "reviews"."id" = "findings"."review_id" AND "reviews"."task_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "review_runs" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_merged_into_finding_id_findings_id_fk" FOREIGN KEY ("merged_into_finding_id") REFERENCES "public"."findings"("id") ON DELETE set null ON UPDATE no action;