-- Connections, repositories and review profiles now belong to an organization.
-- Nothing is live yet: existing rows (and, through CASCADE, their reviews, rules,
-- jobs and ralph runs) are deleted instead of migrated.
TRUNCATE TABLE "scm_connections", "repositories", "review_profiles" CASCADE;--> statement-breakpoint
ALTER TABLE "repositories" DROP CONSTRAINT "repositories_profile_id_review_profiles_id_fk";--> statement-breakpoint
ALTER TABLE "reviews" DROP CONSTRAINT "reviews_profile_id_review_profiles_id_fk";--> statement-breakpoint
ALTER TABLE "review_profiles" DROP CONSTRAINT "review_profiles_pkey";--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "organization_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "review_profiles" ADD COLUMN "organization_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "scm_connections" ADD COLUMN "organization_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "review_profiles" ADD CONSTRAINT "review_profiles_organization_id_id_pk" PRIMARY KEY("organization_id","id");--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_organization_profile_fk" FOREIGN KEY ("organization_id","profile_id") REFERENCES "public"."review_profiles"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_profiles" ADD CONSTRAINT "review_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scm_connections" ADD CONSTRAINT "scm_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "repositories_organization_id_idx" ON "repositories" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "scm_connections_organization_id_idx" ON "scm_connections" USING btree ("organization_id");
