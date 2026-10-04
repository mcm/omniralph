CREATE TYPE "public"."agent_audit_event" AS ENUM('enroll', 'token_refresh', 'refresh_reuse', 'revoke', 'credential_issued', 'result_submitted', 'auth_failed');--> statement-breakpoint
CREATE TABLE "agent_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid,
	"event" "agent_audit_event" NOT NULL,
	"ip" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "agent_refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limits_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
ALTER TABLE "agent_audit" ADD CONSTRAINT "agent_audit_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_refresh_tokens" ADD CONSTRAINT "agent_refresh_tokens_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_audit_agent_id_created_at_idx" ON "agent_audit" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_audit_created_at_idx" ON "agent_audit" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "agent_refresh_tokens_agent_id_idx" ON "agent_refresh_tokens" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_refresh_tokens_family_id_idx" ON "agent_refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "rate_limits_window_start_idx" ON "rate_limits" USING btree ("window_start");--> statement-breakpoint
-- Agents authenticate with rotating refresh tokens (agent_refresh_tokens), never a static token hash.
ALTER TABLE "agents" DROP COLUMN IF EXISTS "token_hash";
