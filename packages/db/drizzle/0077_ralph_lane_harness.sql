ALTER TABLE "ralph_lanes" ADD COLUMN "harness_id" uuid;--> statement-breakpoint
ALTER TABLE "ralph_lanes" ADD CONSTRAINT "ralph_lanes_harness_id_harnesses_id_fk" FOREIGN KEY ("harness_id") REFERENCES "public"."harnesses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Every existing lane sticks to its run's harness.
UPDATE "ralph_lanes" SET "harness_id" = "ralph_runs"."harness_id" FROM "ralph_runs" WHERE "ralph_runs"."id" = "ralph_lanes"."run_id";
