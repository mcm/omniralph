CREATE TYPE "public"."work_item_event_kind" AS ENUM('created', 'repo_changed', 'repo_reset', 'moved_to_needs_refining', 'prd_edited', 'triage_requested', 'started', 'share_link_created', 'share_link_revoked', 'canceled');--> statement-breakpoint
CREATE TABLE "work_item_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"tracker" "work_item_tracker" NOT NULL,
	"external_id" text NOT NULL,
	"actor_user_id" text,
	"actor_name" text NOT NULL,
	"kind" "work_item_event_kind" NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_item_overrides" (
	"organization_id" uuid NOT NULL,
	"tracker" "work_item_tracker" NOT NULL,
	"external_id" text NOT NULL,
	"repository_id" uuid,
	"chosen_by" text,
	"chosen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_item_overrides_organization_id_tracker_external_id_pk" PRIMARY KEY("organization_id","tracker","external_id")
);
--> statement-breakpoint
ALTER TABLE "work_item_events" ADD CONSTRAINT "work_item_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_item_events" ADD CONSTRAINT "work_item_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_item_overrides" ADD CONSTRAINT "work_item_overrides_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_item_overrides" ADD CONSTRAINT "work_item_overrides_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_item_overrides" ADD CONSTRAINT "work_item_overrides_chosen_by_users_id_fk" FOREIGN KEY ("chosen_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_item_events_item_idx" ON "work_item_events" USING btree ("organization_id","tracker","external_id","created_at");--> statement-breakpoint
CREATE INDEX "work_item_overrides_repository_id_idx" ON "work_item_overrides" USING btree ("repository_id");