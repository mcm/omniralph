CREATE TABLE "pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pools" ADD CONSTRAINT "pools_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pools_organization_name_uq" ON "pools" USING btree ("organization_id","name");--> statement-breakpoint
INSERT INTO "pools" ("organization_id", "name")
SELECT "id", p."name" FROM "organizations" CROSS JOIN (VALUES ('short'), ('long')) AS p("name");--> statement-breakpoint
ALTER TABLE "harnesses" ADD COLUMN "accepted_task_types" text[] DEFAULT '{query,review}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "harnesses" ADD COLUMN "pool_limits" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "harnesses" SET
	"accepted_task_types" = ARRAY(
		SELECT DISTINCT t FROM unnest("enabled_capabilities") AS c
		CROSS JOIN LATERAL unnest(CASE c
			WHEN 'review' THEN '{query,review}'::text[]
			WHEN 'ralph' THEN '{coding}'::text[]
			WHEN 'triage' THEN '{query}'::text[]
			ELSE '{}'::text[]
		END) AS t
		ORDER BY t
	),
	-- least() ignores nulls: the smaller of review's and triage's limits.
	"pool_limits" = jsonb_strip_nulls(jsonb_build_object(
		'short', least(("capability_limits"->>'review')::int, ("capability_limits"->>'triage')::int),
		'long', ("capability_limits"->>'ralph')::int
	));--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "task_type" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "pool" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "task_id" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "min_harness_version" text;--> statement-breakpoint
UPDATE "jobs" SET "task_type" = CASE
	WHEN "type" = 'review.run' THEN 'review'
	WHEN "type" IN ('review.reply', 'review.learn-rule', 'chat.ask', 'triage.run', 'ralph.describe-pr') THEN 'query'
	WHEN "type" IN ('ralph.story', 'ralph.request', 'ralph.prepare', 'ralph.cleanup') THEN 'coding'
	WHEN "type" = 'repo.sync' THEN 'system'
	-- Types no longer created: by capability.
	WHEN "capability" = 'ralph' THEN 'coding'
	WHEN "capability" = 'system' THEN 'system'
	ELSE 'query'
END;--> statement-breakpoint
UPDATE "jobs" SET "pool" = CASE "task_type"
	WHEN 'system' THEN NULL
	WHEN 'coding' THEN 'long'
	ELSE 'short'
END;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "task_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_task_type_valid" CHECK ("jobs"."task_type" in ('query', 'review', 'coding', 'system'));--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_pool_system_only_null" CHECK (("jobs"."task_type" = 'system') = ("jobs"."pool" is null));--> statement-breakpoint
DROP INDEX "jobs_claim_queued_idx";--> statement-breakpoint
DROP INDEX "jobs_claim_lease_idx";--> statement-breakpoint
CREATE INDEX "jobs_claim_queued_idx" ON "jobs" USING btree ("organization_id","task_type","status","available_at") WHERE status = 'queued';--> statement-breakpoint
CREATE INDEX "jobs_claim_lease_idx" ON "jobs" USING btree ("organization_id","task_type","lease_expires_at") WHERE status = 'running';
