ALTER TYPE "public"."agent_audit_event" ADD VALUE 'delete' BEFORE 'credential_issued';--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "deleted_at" timestamp with time zone;