CREATE TABLE "ralph_lanes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"branch" text NOT NULL,
	"base_branch" text NOT NULL,
	"pr_number" integer,
	"pr_url" text,
	"pr_closed" boolean DEFAULT false NOT NULL,
	"pr_merged" boolean DEFAULT false NOT NULL,
	"merge_sha" text,
	"review_rounds" integer DEFAULT 0 NOT NULL,
	"handled_review_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ci_fix_rounds" integer DEFAULT 0 NOT NULL,
	"handled_ci_shas" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pending_requests" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"request_claude_session_id" text,
	"request_agent_id" uuid,
	"stashes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cleanup" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ralph_stories" ADD COLUMN "lane_id" uuid;--> statement-breakpoint
ALTER TABLE "ralph_stories" ADD COLUMN "elsewhere" text;--> statement-breakpoint
ALTER TABLE "ralph_lanes" ADD CONSTRAINT "ralph_lanes_run_id_ralph_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ralph_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ralph_lanes" ADD CONSTRAINT "ralph_lanes_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ralph_lanes" ADD CONSTRAINT "ralph_lanes_request_agent_id_agents_id_fk" FOREIGN KEY ("request_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ralph_lanes_run_repository_uq" ON "ralph_lanes" USING btree ("run_id","repository_id");--> statement-breakpoint
CREATE INDEX "ralph_lanes_repository_pr_idx" ON "ralph_lanes" USING btree ("repository_id","pr_number");--> statement-breakpoint
ALTER TABLE "ralph_messages" ADD CONSTRAINT "ralph_messages_lane_id_ralph_lanes_id_fk" FOREIGN KEY ("lane_id") REFERENCES "public"."ralph_lanes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ralph_stories" ADD CONSTRAINT "ralph_stories_lane_id_ralph_lanes_id_fk" FOREIGN KEY ("lane_id") REFERENCES "public"."ralph_lanes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Every run with a repository gets its main lane, with the run's branch and PR/MR.
INSERT INTO "ralph_lanes" ("run_id", "repository_id", "branch", "base_branch", "pr_number", "pr_url", "created_at", "updated_at")
SELECT "id", "repository_id", "branch", "base_branch", "pr_number", "pr_url", "created_at", "updated_at"
FROM "ralph_runs" WHERE "repository_id" IS NOT NULL;--> statement-breakpoint
UPDATE "ralph_stories" SET "lane_id" = l."id"
FROM "ralph_lanes" l JOIN "ralph_runs" r ON r."id" = l."run_id" AND r."repository_id" = l."repository_id"
WHERE "ralph_stories"."run_id" = r."id";--> statement-breakpoint
ALTER TABLE "ralph_runs" DROP COLUMN "branch";--> statement-breakpoint
ALTER TABLE "ralph_runs" DROP COLUMN "base_branch";--> statement-breakpoint
ALTER TABLE "ralph_runs" DROP COLUMN "pr_number";--> statement-breakpoint
ALTER TABLE "ralph_runs" DROP COLUMN "pr_url";