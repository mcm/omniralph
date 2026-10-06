CREATE TYPE "public"."integration_provider" AS ENUM('linear');--> statement-breakpoint
CREATE TYPE "public"."webhook_provider" AS ENUM('github', 'gitlab', 'linear');--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"encrypted_credentials" text NOT NULL,
	"installed_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ALTER COLUMN "provider" SET DATA TYPE "public"."webhook_provider" USING "provider"::text::"public"."webhook_provider";--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_installed_by_user_id_users_id_fk" FOREIGN KEY ("installed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_provider_external_id_uq" ON "integrations" USING btree ("provider","external_id");