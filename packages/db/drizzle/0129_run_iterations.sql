CREATE TABLE "run_iterations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"run_kind" text NOT NULL,
	"run_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"status" text DEFAULT 'working' NOT NULL,
	"feedback" text,
	"worker_job_id" uuid,
	"verifier_job_id" uuid,
	"verdict" text,
	"metric" jsonb,
	"summary" text,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"outcome" text,
	"max_iterations" integer NOT NULL,
	"stall_rounds" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verifying_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "run_iterations_run_kind_valid" CHECK ("run_iterations"."run_kind" in ('review', 'triage')),
	CONSTRAINT "run_iterations_status_valid" CHECK ("run_iterations"."status" in ('working', 'verifying', 'done', 'failed')),
	CONSTRAINT "run_iterations_verdict_valid" CHECK ("run_iterations"."verdict" is null or "run_iterations"."verdict" in ('converged', 'continue')),
	CONSTRAINT "run_iterations_outcome_valid" CHECK ("run_iterations"."outcome" is null or "run_iterations"."outcome" in ('converged', 'max-iterations', 'stalled', 'failed')),
	CONSTRAINT "run_iterations_number_positive" CHECK ("run_iterations"."number" >= 1)
);
--> statement-breakpoint
ALTER TABLE "run_iterations" ADD CONSTRAINT "run_iterations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_iterations" ADD CONSTRAINT "run_iterations_worker_job_id_jobs_id_fk" FOREIGN KEY ("worker_job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_iterations" ADD CONSTRAINT "run_iterations_verifier_job_id_jobs_id_fk" FOREIGN KEY ("verifier_job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_iterations_run_number_uq" ON "run_iterations" USING btree ("run_kind","run_id","number");--> statement-breakpoint
CREATE INDEX "run_iterations_worker_job_id_idx" ON "run_iterations" USING btree ("worker_job_id");--> statement-breakpoint
CREATE INDEX "run_iterations_verifier_job_id_idx" ON "run_iterations" USING btree ("verifier_job_id");