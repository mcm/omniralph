CREATE TABLE "harness_host_tools" (
	"harness_id" uuid NOT NULL,
	"host_tool_id" uuid NOT NULL,
	"configured_path" text,
	"configured_path_exists" boolean,
	"discovered_path" text,
	"reported_at" timestamp with time zone,
	CONSTRAINT "harness_host_tools_harness_id_host_tool_id_pk" PRIMARY KEY("harness_id","host_tool_id")
);
--> statement-breakpoint
CREATE TABLE "host_tools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "harness_host_tools" ADD CONSTRAINT "harness_host_tools_harness_id_harnesses_id_fk" FOREIGN KEY ("harness_id") REFERENCES "public"."harnesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "harness_host_tools" ADD CONSTRAINT "harness_host_tools_host_tool_id_host_tools_id_fk" FOREIGN KEY ("host_tool_id") REFERENCES "public"."host_tools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host_tools" ADD CONSTRAINT "host_tools_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "harness_host_tools_host_tool_id_idx" ON "harness_host_tools" USING btree ("host_tool_id");--> statement-breakpoint
CREATE UNIQUE INDEX "host_tools_organization_name_uq" ON "host_tools" USING btree ("organization_id","name");