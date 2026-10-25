CREATE TYPE "public"."inbox_item_state" AS ENUM('done', 'snoozed');--> statement-breakpoint
CREATE TABLE "inbox_item_states" (
	"user_id" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"state" "inbox_item_state" NOT NULL,
	"snoozed_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_item_states_user_id_item_key_pk" PRIMARY KEY("user_id","item_key"),
	CONSTRAINT "inbox_item_states_snooze" CHECK (("inbox_item_states"."state" = 'snoozed') = ("inbox_item_states"."snoozed_until" is not null))
);
--> statement-breakpoint
ALTER TABLE "inbox_item_states" ADD CONSTRAINT "inbox_item_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_item_states" ADD CONSTRAINT "inbox_item_states_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbox_item_states_updated_at_idx" ON "inbox_item_states" USING btree ("updated_at");