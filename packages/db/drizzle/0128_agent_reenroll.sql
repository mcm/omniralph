ALTER TYPE "public"."agent_audit_event" ADD VALUE 'reenroll' BEFORE 'token_refresh';--> statement-breakpoint
ALTER TABLE "agent_enrollments" ADD COLUMN "reenroll_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "refresh_family_start" integer;--> statement-breakpoint
ALTER TABLE "agent_enrollments" ADD CONSTRAINT "agent_enrollments_reenroll_agent_id_agents_id_fk" FOREIGN KEY ("reenroll_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;