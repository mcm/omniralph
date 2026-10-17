CREATE TABLE "follow_up_sources" (
	"organization_id" uuid NOT NULL,
	"issue_id" text NOT NULL,
	"source_issue_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follow_up_sources_organization_id_issue_id_pk" PRIMARY KEY("organization_id","issue_id")
);
--> statement-breakpoint
ALTER TABLE "follow_up_sources" ADD CONSTRAINT "follow_up_sources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;