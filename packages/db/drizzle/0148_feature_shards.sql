CREATE TYPE "public"."feature_shard_status" AS ENUM('drafting', 'review', 'filing', 'filed', 'failed', 'canceled');--> statement-breakpoint
CREATE TABLE "feature_shards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"feature_id" uuid NOT NULL,
	"status" "feature_shard_status" DEFAULT 'drafting' NOT NULL,
	"plan_version" integer NOT NULL,
	"sections" jsonb NOT NULL,
	"drafts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"exempt" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text,
	"leftovers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"outcome" text,
	"error" text,
	"repository_id" uuid,
	"created_by" text,
	"filed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"filed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "run_iterations" DROP CONSTRAINT "run_iterations_run_kind_valid";--> statement-breakpoint
ALTER TABLE "features" ADD COLUMN "parent_issue" jsonb;--> statement-breakpoint
ALTER TABLE "feature_shards" ADD CONSTRAINT "feature_shards_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_shards" ADD CONSTRAINT "feature_shards_feature_id_features_id_fk" FOREIGN KEY ("feature_id") REFERENCES "public"."features"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_shards" ADD CONSTRAINT "feature_shards_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_shards" ADD CONSTRAINT "feature_shards_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_shards" ADD CONSTRAINT "feature_shards_filed_by_users_id_fk" FOREIGN KEY ("filed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feature_shards_feature_idx" ON "feature_shards" USING btree ("feature_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "feature_shards_feature_active_uq" ON "feature_shards" USING btree ("feature_id") WHERE status in ('drafting', 'review', 'filing');--> statement-breakpoint
ALTER TABLE "run_iterations" ADD CONSTRAINT "run_iterations_run_kind_valid" CHECK ("run_iterations"."run_kind" in ('review', 'triage', 'shard'));