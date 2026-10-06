CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "desired_version" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "self_update" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "update_state" jsonb;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "failed_versions" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;