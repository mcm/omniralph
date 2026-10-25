ALTER TABLE "pools" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "pools" CASCADE;--> statement-breakpoint
ALTER TABLE "jobs" DROP CONSTRAINT "jobs_pool_system_only_null";--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "pool";--> statement-breakpoint
-- A task's pool follows from its task type: custom task definitions drop the one they stored.
UPDATE "task_definitions" SET "definition" = "definition" - 'pool' WHERE "definition" ? 'pool';
