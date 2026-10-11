-- Renames agents to harnesses ("agent" now means an AI agent definition). Renames
-- only, so every row is kept.
ALTER TYPE "public"."agent_audit_event" RENAME TO "harness_audit_event";
--> statement-breakpoint
ALTER TABLE "agents" RENAME TO "harnesses";
--> statement-breakpoint
ALTER TABLE "agent_enrollments" RENAME TO "harness_enrollments";
--> statement-breakpoint
ALTER TABLE "agent_refresh_tokens" RENAME TO "harness_refresh_tokens";
--> statement-breakpoint
ALTER TABLE "agent_audit" RENAME TO "harness_audit";
--> statement-breakpoint
ALTER TABLE "agent_repo_pins" RENAME TO "harness_repo_pins";
--> statement-breakpoint
ALTER TABLE "harness_enrollments" RENAME COLUMN "agent_id" TO "harness_id";
--> statement-breakpoint
ALTER TABLE "harness_refresh_tokens" RENAME COLUMN "agent_id" TO "harness_id";
--> statement-breakpoint
ALTER TABLE "harness_audit" RENAME COLUMN "agent_id" TO "harness_id";
--> statement-breakpoint
ALTER TABLE "harness_repo_pins" RENAME COLUMN "agent_id" TO "harness_id";
--> statement-breakpoint
ALTER TABLE "jobs" RENAME COLUMN "agent_id" TO "harness_id";
--> statement-breakpoint
ALTER TABLE "reviews" RENAME COLUMN "agent_id" TO "harness_id";
--> statement-breakpoint
ALTER TABLE "ralph_runs" RENAME COLUMN "agent_id" TO "harness_id";
--> statement-breakpoint
ALTER TABLE "jobs" RENAME COLUMN "target_agent_id" TO "target_harness_id";
--> statement-breakpoint
ALTER TABLE "ralph_lanes" RENAME COLUMN "request_agent_id" TO "request_harness_id";
--> statement-breakpoint
ALTER TABLE "harnesses" RENAME CONSTRAINT "agents_pkey" TO "harnesses_pkey";
--> statement-breakpoint
ALTER TABLE "harness_enrollments" RENAME CONSTRAINT "agent_enrollments_pkey" TO "harness_enrollments_pkey";
--> statement-breakpoint
ALTER TABLE "harness_refresh_tokens" RENAME CONSTRAINT "agent_refresh_tokens_pkey" TO "harness_refresh_tokens_pkey";
--> statement-breakpoint
ALTER TABLE "harness_audit" RENAME CONSTRAINT "agent_audit_pkey" TO "harness_audit_pkey";
--> statement-breakpoint
ALTER TABLE "harness_repo_pins" RENAME CONSTRAINT "agent_repo_pins_pkey" TO "harness_repo_pins_pkey";
--> statement-breakpoint
ALTER TABLE "harnesses" RENAME CONSTRAINT "agents_organization_id_organizations_id_fk" TO "harnesses_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "harnesses" RENAME CONSTRAINT "agents_enrolled_by_users_id_fk" TO "harnesses_enrolled_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "harness_enrollments" RENAME CONSTRAINT "agent_enrollments_organization_id_organizations_id_fk" TO "harness_enrollments_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "harness_enrollments" RENAME CONSTRAINT "agent_enrollments_agent_id_agents_id_fk" TO "harness_enrollments_harness_id_harnesses_id_fk";
--> statement-breakpoint
ALTER TABLE "harness_enrollments" RENAME CONSTRAINT "agent_enrollments_created_by_users_id_fk" TO "harness_enrollments_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "harness_enrollments" RENAME CONSTRAINT "agent_enrollments_token_hash_unique" TO "harness_enrollments_token_hash_unique";
--> statement-breakpoint
ALTER TABLE "harness_refresh_tokens" RENAME CONSTRAINT "agent_refresh_tokens_agent_id_agents_id_fk" TO "harness_refresh_tokens_harness_id_harnesses_id_fk";
--> statement-breakpoint
ALTER TABLE "harness_refresh_tokens" RENAME CONSTRAINT "agent_refresh_tokens_token_hash_unique" TO "harness_refresh_tokens_token_hash_unique";
--> statement-breakpoint
ALTER TABLE "harness_audit" RENAME CONSTRAINT "agent_audit_agent_id_agents_id_fk" TO "harness_audit_harness_id_harnesses_id_fk";
--> statement-breakpoint
ALTER TABLE "harness_repo_pins" RENAME CONSTRAINT "agent_repo_pins_agent_id_agents_id_fk" TO "harness_repo_pins_harness_id_harnesses_id_fk";
--> statement-breakpoint
ALTER TABLE "harness_repo_pins" RENAME CONSTRAINT "agent_repo_pins_repository_id_repositories_id_fk" TO "harness_repo_pins_repository_id_repositories_id_fk";
--> statement-breakpoint
ALTER TABLE "jobs" RENAME CONSTRAINT "jobs_agent_id_agents_id_fk" TO "jobs_harness_id_harnesses_id_fk";
--> statement-breakpoint
ALTER TABLE "jobs" RENAME CONSTRAINT "jobs_target_agent_id_agents_id_fk" TO "jobs_target_harness_id_harnesses_id_fk";
--> statement-breakpoint
ALTER TABLE "reviews" RENAME CONSTRAINT "reviews_agent_id_agents_id_fk" TO "reviews_harness_id_harnesses_id_fk";
--> statement-breakpoint
ALTER TABLE "ralph_runs" RENAME CONSTRAINT "ralph_runs_agent_id_agents_id_fk" TO "ralph_runs_harness_id_harnesses_id_fk";
--> statement-breakpoint
ALTER TABLE "ralph_lanes" RENAME CONSTRAINT "ralph_lanes_request_agent_id_agents_id_fk" TO "ralph_lanes_request_harness_id_harnesses_id_fk";
--> statement-breakpoint
ALTER INDEX "agents_organization_id_idx" RENAME TO "harnesses_organization_id_idx";
--> statement-breakpoint
ALTER INDEX "agent_refresh_tokens_agent_id_idx" RENAME TO "harness_refresh_tokens_harness_id_idx";
--> statement-breakpoint
ALTER INDEX "agent_refresh_tokens_family_id_idx" RENAME TO "harness_refresh_tokens_family_id_idx";
--> statement-breakpoint
ALTER INDEX "agent_audit_agent_id_created_at_idx" RENAME TO "harness_audit_harness_id_created_at_idx";
--> statement-breakpoint
ALTER INDEX "agent_audit_created_at_idx" RENAME TO "harness_audit_created_at_idx";
--> statement-breakpoint
ALTER INDEX "agent_repo_pins_agent_repo_uq" RENAME TO "harness_repo_pins_harness_repo_uq";
--> statement-breakpoint
ALTER INDEX "agent_repo_pins_repository_id_idx" RENAME TO "harness_repo_pins_repository_id_idx";
--> statement-breakpoint
ALTER INDEX "jobs_agent_id_idx" RENAME TO "jobs_harness_id_idx";
--> statement-breakpoint
UPDATE "app_settings" SET "key" = 'harness.desiredVersion' WHERE "key" = 'agent.desiredVersion';
--> statement-breakpoint
-- The cached npm `latest` was the old @omniralph/agent package's; it is read again for @omniralph/harness.
DELETE FROM "app_settings" WHERE "key" = 'agent.latestVersion';