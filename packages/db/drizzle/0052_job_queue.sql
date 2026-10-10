ALTER TABLE "jobs" ADD COLUMN "target_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "available_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_target_agent_id_agents_id_fk" FOREIGN KEY ("target_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_claim_queued_idx" ON "jobs" USING btree ("organization_id","status","available_at") WHERE status = 'queued';--> statement-breakpoint
CREATE INDEX "jobs_claim_lease_idx" ON "jobs" USING btree ("organization_id","lease_expires_at") WHERE status = 'running';--> statement-breakpoint
-- Jobs published to a per-agent topic (`agentTopic(capability, agentId)`) stay targeted at that agent.
UPDATE "jobs" SET "target_agent_id" = "agents"."id"
FROM "agents"
WHERE "jobs"."status" IN ('queued', 'running')
  AND "jobs"."topic" = "jobs"."capability" || '-jobs-agent-' || "agents"."id"::text;--> statement-breakpoint
-- Running jobs get a lease (JOB_LEASE_SECONDS); their agents' heartbeats renew it.
UPDATE "jobs" SET "lease_expires_at" = now() + interval '120 seconds' WHERE "status" = 'running';
