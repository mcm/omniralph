DROP TABLE "allowed_emails" CASCADE;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "role";--> statement-breakpoint
DROP TYPE "public"."user_role";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "active_organization_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_active_organization_id_organizations_id_fk" FOREIGN KEY ("active_organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;