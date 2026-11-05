CREATE TABLE "feature_epics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feature_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"tracker" "work_item_tracker" NOT NULL,
	"external_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feature_epics" ADD CONSTRAINT "feature_epics_feature_id_features_id_fk" FOREIGN KEY ("feature_id") REFERENCES "public"."features"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_epics" ADD CONSTRAINT "feature_epics_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feature_epics_feature_idx" ON "feature_epics" USING btree ("feature_id");--> statement-breakpoint
CREATE UNIQUE INDEX "feature_epics_item_uq" ON "feature_epics" USING btree ("organization_id","tracker","external_id");