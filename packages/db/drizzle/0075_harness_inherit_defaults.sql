ALTER TABLE "harnesses" ALTER COLUMN "max_concurrency" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "harnesses" ALTER COLUMN "max_concurrency" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "harnesses" ALTER COLUMN "accepted_task_types" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "harnesses" ALTER COLUMN "accepted_task_types" DROP NOT NULL;--> statement-breakpoint
-- Every existing harness inherits the organization's defaults (pool limits derive from them).
UPDATE "harnesses" SET "max_concurrency" = NULL, "accepted_task_types" = NULL, "pool_limits" = '{}'::jsonb;
