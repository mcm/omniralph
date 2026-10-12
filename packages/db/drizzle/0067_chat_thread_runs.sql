CREATE TYPE "public"."chat_thread_run_kind" AS ENUM('query', 'coding');--> statement-breakpoint
CREATE TABLE "chat_thread_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"kind" "chat_thread_run_kind" NOT NULL,
	"job_id" uuid,
	"ralph_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_thread_runs_kind_check" CHECK ((kind = 'query' and job_id is not null and ralph_run_id is null)
        or (kind = 'coding' and ralph_run_id is not null and job_id is null))
);
--> statement-breakpoint
ALTER TABLE "chat_thread_runs" ADD CONSTRAINT "chat_thread_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_thread_runs" ADD CONSTRAINT "chat_thread_runs_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_thread_runs" ADD CONSTRAINT "chat_thread_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_thread_runs" ADD CONSTRAINT "chat_thread_runs_ralph_run_id_ralph_runs_id_fk" FOREIGN KEY ("ralph_run_id") REFERENCES "public"."ralph_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_thread_runs_job_id_uq" ON "chat_thread_runs" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_thread_runs_ralph_run_id_uq" ON "chat_thread_runs" USING btree ("ralph_run_id");--> statement-breakpoint
CREATE INDEX "chat_thread_runs_chat_thread_id_created_at_idx" ON "chat_thread_runs" USING btree ("chat_thread_id","created_at");--> statement-breakpoint
INSERT INTO "chat_thread_runs" ("organization_id", "chat_thread_id", "kind", "ralph_run_id", "created_at")
SELECT r."organization_id", r."chat_thread_id", 'coding', r."id", r."created_at"
FROM "ralph_runs" r
JOIN "chat_threads" t ON t."id" = r."chat_thread_id" AND t."organization_id" = r."organization_id"
WHERE r."origin" = 'chat';--> statement-breakpoint
INSERT INTO "chat_thread_runs" ("organization_id", "chat_thread_id", "kind", "job_id", "created_at")
SELECT t."organization_id", t."id", 'query', j."id", j."created_at"
FROM "jobs" j
JOIN "chat_threads" t ON t."id"::text = coalesce(
  j."payload"->>'chatThreadId',
  j."payload"->'trigger'->'context'->>'chatThreadId'
) AND t."organization_id" = j."organization_id";
