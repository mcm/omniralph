-- Renames harnesses to agents ("agent" now means the machine again, as before 0055). Renames
--> statement-breakpoint
-- only, so every row is kept.
--> statement-breakpoint
ALTER TYPE "public"."harness_audit_event" RENAME TO "agent_audit_event";
--> statement-breakpoint
ALTER TABLE "harnesses" RENAME TO "agents";
--> statement-breakpoint
ALTER TABLE "harness_enrollments" RENAME TO "agent_enrollments";
--> statement-breakpoint
ALTER TABLE "harness_refresh_tokens" RENAME TO "agent_refresh_tokens";
--> statement-breakpoint
ALTER TABLE "harness_audit" RENAME TO "agent_audit";
--> statement-breakpoint
ALTER TABLE "harness_repo_pins" RENAME TO "agent_repo_pins";
--> statement-breakpoint
ALTER TABLE "harness_host_tools" RENAME TO "agent_host_tools";
--> statement-breakpoint
ALTER TABLE "agent_enrollments" RENAME COLUMN "harness_id" TO "agent_id";
--> statement-breakpoint
ALTER TABLE "agent_refresh_tokens" RENAME COLUMN "harness_id" TO "agent_id";
--> statement-breakpoint
ALTER TABLE "agent_audit" RENAME COLUMN "harness_id" TO "agent_id";
--> statement-breakpoint
ALTER TABLE "agent_repo_pins" RENAME COLUMN "harness_id" TO "agent_id";
--> statement-breakpoint
ALTER TABLE "agent_host_tools" RENAME COLUMN "harness_id" TO "agent_id";
--> statement-breakpoint
ALTER TABLE "jobs" RENAME COLUMN "harness_id" TO "agent_id";
--> statement-breakpoint
ALTER TABLE "reviews" RENAME COLUMN "harness_id" TO "agent_id";
--> statement-breakpoint
ALTER TABLE "ralph_runs" RENAME COLUMN "harness_id" TO "agent_id";
--> statement-breakpoint
ALTER TABLE "ralph_lanes" RENAME COLUMN "harness_id" TO "agent_id";
--> statement-breakpoint
ALTER TABLE "jobs" RENAME COLUMN "target_harness_id" TO "target_agent_id";
--> statement-breakpoint
ALTER TABLE "jobs" RENAME COLUMN "min_harness_version" TO "min_agent_version";
--> statement-breakpoint
ALTER TABLE "ralph_lanes" RENAME COLUMN "request_harness_id" TO "request_agent_id";
--> statement-breakpoint
ALTER TABLE "agents" RENAME CONSTRAINT "harnesses_pkey" TO "agents_pkey";
--> statement-breakpoint
ALTER TABLE "agent_enrollments" RENAME CONSTRAINT "harness_enrollments_pkey" TO "agent_enrollments_pkey";
--> statement-breakpoint
ALTER TABLE "agent_refresh_tokens" RENAME CONSTRAINT "harness_refresh_tokens_pkey" TO "agent_refresh_tokens_pkey";
--> statement-breakpoint
ALTER TABLE "agent_audit" RENAME CONSTRAINT "harness_audit_pkey" TO "agent_audit_pkey";
--> statement-breakpoint
ALTER TABLE "agent_repo_pins" RENAME CONSTRAINT "harness_repo_pins_pkey" TO "agent_repo_pins_pkey";
--> statement-breakpoint
ALTER TABLE "agent_host_tools" RENAME CONSTRAINT "harness_host_tools_harness_id_host_tool_id_pk" TO "agent_host_tools_agent_id_host_tool_id_pk";
--> statement-breakpoint
ALTER TABLE "agents" RENAME CONSTRAINT "harnesses_organization_id_organizations_id_fk" TO "agents_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "agents" RENAME CONSTRAINT "harnesses_enrolled_by_users_id_fk" TO "agents_enrolled_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_enrollments" RENAME CONSTRAINT "harness_enrollments_organization_id_organizations_id_fk" TO "agent_enrollments_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_enrollments" RENAME CONSTRAINT "harness_enrollments_harness_id_harnesses_id_fk" TO "agent_enrollments_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_enrollments" RENAME CONSTRAINT "harness_enrollments_created_by_users_id_fk" TO "agent_enrollments_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_enrollments" RENAME CONSTRAINT "harness_enrollments_token_hash_unique" TO "agent_enrollments_token_hash_unique";
--> statement-breakpoint
ALTER TABLE "agent_refresh_tokens" RENAME CONSTRAINT "harness_refresh_tokens_harness_id_harnesses_id_fk" TO "agent_refresh_tokens_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_refresh_tokens" RENAME CONSTRAINT "harness_refresh_tokens_token_hash_unique" TO "agent_refresh_tokens_token_hash_unique";
--> statement-breakpoint
ALTER TABLE "agent_audit" RENAME CONSTRAINT "harness_audit_harness_id_harnesses_id_fk" TO "agent_audit_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_repo_pins" RENAME CONSTRAINT "harness_repo_pins_harness_id_harnesses_id_fk" TO "agent_repo_pins_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_repo_pins" RENAME CONSTRAINT "harness_repo_pins_repository_id_repositories_id_fk" TO "agent_repo_pins_repository_id_repositories_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_host_tools" RENAME CONSTRAINT "harness_host_tools_harness_id_harnesses_id_fk" TO "agent_host_tools_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_host_tools" RENAME CONSTRAINT "harness_host_tools_host_tool_id_host_tools_id_fk" TO "agent_host_tools_host_tool_id_host_tools_id_fk";
--> statement-breakpoint
ALTER TABLE "jobs" RENAME CONSTRAINT "jobs_harness_id_harnesses_id_fk" TO "jobs_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "jobs" RENAME CONSTRAINT "jobs_target_harness_id_harnesses_id_fk" TO "jobs_target_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "reviews" RENAME CONSTRAINT "reviews_harness_id_harnesses_id_fk" TO "reviews_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "ralph_runs" RENAME CONSTRAINT "ralph_runs_harness_id_harnesses_id_fk" TO "ralph_runs_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "ralph_lanes" RENAME CONSTRAINT "ralph_lanes_harness_id_harnesses_id_fk" TO "ralph_lanes_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "ralph_lanes" RENAME CONSTRAINT "ralph_lanes_request_harness_id_harnesses_id_fk" TO "ralph_lanes_request_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER INDEX "harnesses_organization_id_idx" RENAME TO "agents_organization_id_idx";
--> statement-breakpoint
ALTER INDEX "harness_refresh_tokens_harness_id_idx" RENAME TO "agent_refresh_tokens_agent_id_idx";
--> statement-breakpoint
ALTER INDEX "harness_refresh_tokens_family_id_idx" RENAME TO "agent_refresh_tokens_family_id_idx";
--> statement-breakpoint
ALTER INDEX "harness_audit_harness_id_created_at_idx" RENAME TO "agent_audit_agent_id_created_at_idx";
--> statement-breakpoint
ALTER INDEX "harness_audit_created_at_idx" RENAME TO "agent_audit_created_at_idx";
--> statement-breakpoint
ALTER INDEX "harness_repo_pins_harness_repo_uq" RENAME TO "agent_repo_pins_agent_repo_uq";
--> statement-breakpoint
ALTER INDEX "harness_repo_pins_repository_id_idx" RENAME TO "agent_repo_pins_repository_id_idx";
--> statement-breakpoint
ALTER INDEX "harness_host_tools_host_tool_id_idx" RENAME TO "agent_host_tools_host_tool_id_idx";
--> statement-breakpoint
ALTER INDEX "jobs_harness_id_idx" RENAME TO "jobs_agent_id_idx";
--> statement-breakpoint
-- Whether a version is `latest` or at least 2.0.0, the first @omniralph/agent release (a
-- prerelease of 2.0.0 is below it). Everything else names an @omniralph/harness version.
CREATE FUNCTION "pg_temp"."agent_version_kept"(v text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT v = 'latest' OR (
    v ~ '^\d+\.\d+\.\d+([-+].*)?$'
    AND (
      (regexp_match(v, '^(\d+)\.(\d+)\.(\d+)'))::int[] > ARRAY[2, 0, 0]
      OR v ~ '^2\.0\.0(\+.*)?$'
    )
  )
$$;
--> statement-breakpoint
DELETE FROM "app_settings" WHERE "key" = 'harness.desiredVersion'
  AND (jsonb_typeof("value") <> 'string' OR NOT "pg_temp"."agent_version_kept"("value" #>> '{}'));
--> statement-breakpoint
UPDATE "app_settings" SET "key" = 'agent.' || substr("key", length('harness.') + 1)
  WHERE "key" IN ('harness.desiredVersion', 'harness.maxConcurrency');
--> statement-breakpoint
-- The cached npm `latest` was @omniralph/harness's; it is read again for @omniralph/agent.
DELETE FROM "app_settings" WHERE "key" LIKE 'harness.%';
--> statement-breakpoint
-- Version state naming @omniralph/harness versions is reset; everything else is kept.
UPDATE "agents" SET
  "desired_version" = CASE WHEN "pg_temp"."agent_version_kept"("desired_version") THEN "desired_version" END,
  "failed_versions" = '{}',
  "update_state" = NULL,
  "update_request_id" = NULL,
  "update_request_version" = NULL,
  "update_requested_at" = NULL;
--> statement-breakpoint
DROP FUNCTION "pg_temp"."agent_version_kept"(text);