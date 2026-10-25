CREATE TABLE "settings_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"section" text NOT NULL,
	"subject_id" uuid,
	"actor_user_id" text,
	"actor_name" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changes" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "settings_changes" ADD CONSTRAINT "settings_changes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings_changes" ADD CONSTRAINT "settings_changes_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "settings_changes_organization_section_subject_changed_at_idx" ON "settings_changes" USING btree ("organization_id","section","subject_id","changed_at");