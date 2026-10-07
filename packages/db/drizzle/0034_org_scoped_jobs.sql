-- Jobs now belong to an organization, and only that organization's agents receive
-- them. Nothing is live yet: existing jobs are deleted instead of migrated.
TRUNCATE TABLE "jobs" CASCADE;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "organization_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_organization_created_at_idx" ON "jobs" USING btree ("organization_id","created_at");