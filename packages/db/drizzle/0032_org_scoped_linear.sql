-- The Linear integration and ralph runs now belong to an organization.
-- Nothing is live yet: existing rows (and, through CASCADE, the runs' lanes,
-- stories, messages and jobs) are deleted instead of migrated.
TRUNCATE TABLE "integrations", "ralph_runs" CASCADE;--> statement-breakpoint
DROP INDEX "integrations_provider_uq";--> statement-breakpoint
DROP INDEX "ralph_runs_issue_active_uq";--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "organization_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "ralph_runs" ADD COLUMN "organization_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ralph_runs" ADD CONSTRAINT "ralph_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_provider_external_id_uq" ON "integrations" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX "ralph_runs_organization_created_at_idx" ON "ralph_runs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_provider_uq" ON "integrations" USING btree ("organization_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "ralph_runs_issue_active_uq" ON "ralph_runs" USING btree ("organization_id","linear_issue_id") WHERE status in ('pending', 'running', 'waiting');