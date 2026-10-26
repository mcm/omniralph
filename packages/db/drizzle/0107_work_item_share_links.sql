CREATE TABLE "work_item_share_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"tracker" "work_item_tracker" NOT NULL,
	"external_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"password_hash" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "work_item_share_links_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "work_item_share_links" ADD CONSTRAINT "work_item_share_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_item_share_links" ADD CONSTRAINT "work_item_share_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_item_share_links_item_idx" ON "work_item_share_links" USING btree ("organization_id","tracker","external_id");