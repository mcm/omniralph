CREATE TABLE "run_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"type" text NOT NULL,
	"body" text NOT NULL,
	"parameter" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_activities_type_valid" CHECK ("run_activities"."type" in ('thought', 'action'))
);
--> statement-breakpoint
CREATE TABLE "run_permission_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"request_id" text NOT NULL,
	"tool" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"answer" text,
	"answered_at" timestamp with time zone,
	"answered_by" text,
	CONSTRAINT "run_permission_requests_answer_valid" CHECK ("run_permission_requests"."answer" is null or "run_permission_requests"."answer" in ('allowed', 'denied', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "run_activities" ADD CONSTRAINT "run_activities_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_activities" ADD CONSTRAINT "run_activities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_permission_requests" ADD CONSTRAINT "run_permission_requests_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_activities_job_id_created_at_idx" ON "run_activities" USING btree ("job_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "run_permission_requests_job_request_uq" ON "run_permission_requests" USING btree ("job_id","request_id");