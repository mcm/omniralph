CREATE TYPE "public"."sprint_epic_state" AS ENUM('queued', 'running', 'merged', 'stalled');--> statement-breakpoint
CREATE TYPE "public"."sprint_status" AS ENUM('draft', 'running', 'paused', 'done', 'canceled');--> statement-breakpoint
CREATE TABLE "sprint_epics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sprint_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"tracker" "work_item_tracker" NOT NULL,
	"external_id" text NOT NULL,
	"identifier" text NOT NULL,
	"title" text NOT NULL,
	"position" integer NOT NULL,
	"state" "sprint_epic_state" DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sprints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"name" text NOT NULL,
	"merge_together" boolean DEFAULT false NOT NULL,
	"status" "sprint_status" DEFAULT 'draft' NOT NULL,
	"sprint_branch" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sprint_epics" ADD CONSTRAINT "sprint_epics_sprint_id_sprints_id_fk" FOREIGN KEY ("sprint_id") REFERENCES "public"."sprints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprint_epics" ADD CONSTRAINT "sprint_epics_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprints" ADD CONSTRAINT "sprints_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprints" ADD CONSTRAINT "sprints_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sprints" ADD CONSTRAINT "sprints_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sprint_epics_sprint_position_uq" ON "sprint_epics" USING btree ("sprint_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "sprint_epics_sprint_item_uq" ON "sprint_epics" USING btree ("sprint_id","tracker","external_id");--> statement-breakpoint
CREATE INDEX "sprint_epics_item_idx" ON "sprint_epics" USING btree ("organization_id","tracker","external_id");--> statement-breakpoint
CREATE INDEX "sprints_organization_id_idx" ON "sprints" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "sprints_repository_id_idx" ON "sprints" USING btree ("repository_id");