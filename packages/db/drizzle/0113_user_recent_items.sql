CREATE TYPE "public"."recent_item_kind" AS ENUM('run', 'work_item', 'repository', 'agent', 'settings');--> statement-breakpoint
CREATE TABLE "user_recent_items" (
	"user_id" text NOT NULL,
	"kind" "recent_item_kind" NOT NULL,
	"ref_id" text NOT NULL,
	"organization_id" uuid,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_recent_items_user_id_kind_ref_id_pk" PRIMARY KEY("user_id","kind","ref_id")
);
--> statement-breakpoint
ALTER TABLE "user_recent_items" ADD CONSTRAINT "user_recent_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_recent_items" ADD CONSTRAINT "user_recent_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_recent_items_user_opened_at_idx" ON "user_recent_items" USING btree ("user_id","opened_at");