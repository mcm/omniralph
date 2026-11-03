CREATE TABLE "documentation_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"review_id" uuid,
	"ralph_run_id" uuid,
	"paths" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documentation_requests" ADD CONSTRAINT "documentation_requests_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documentation_requests" ADD CONSTRAINT "documentation_requests_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documentation_requests" ADD CONSTRAINT "documentation_requests_ralph_run_id_ralph_runs_id_fk" FOREIGN KEY ("ralph_run_id") REFERENCES "public"."ralph_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "documentation_requests_repository_pr_head_uq" ON "documentation_requests" USING btree ("repository_id","pr_number","head_sha");