CREATE TYPE "public"."work_item_tracker" AS ENUM('linear');--> statement-breakpoint
CREATE TABLE "work_item_matches" (
	"repository_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"tracker" "work_item_tracker" NOT NULL,
	"team" text NOT NULL,
	"project" text,
	"without_project" boolean DEFAULT false NOT NULL,
	"labels" text[] DEFAULT '{}' NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_item_matches_without_project_no_project" CHECK (not "work_item_matches"."without_project" or "work_item_matches"."project" is null)
);
--> statement-breakpoint
ALTER TABLE "work_item_matches" ADD CONSTRAINT "work_item_matches_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_item_matches" ADD CONSTRAINT "work_item_matches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_item_matches" ADD CONSTRAINT "work_item_matches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_item_matches" ADD CONSTRAINT "work_item_matches_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_item_matches_organization_id_idx" ON "work_item_matches" USING btree ("organization_id");