-- Review depth replaces review profiles. Converting would lose a profile edited away from its
-- built-in values, or one that isn't built in, so stop and name them instead.
DO $$
DECLARE
  offending text;
BEGIN
  SELECT string_agg(format('organization %s profile %L', p."organization_id", p."id"), ', ' ORDER BY p."organization_id", p."id")
  INTO offending
  FROM "review_profiles" p
  LEFT JOIN (VALUES
    ('quick', 'claude-haiku-5-5', 60000, 15, false),
    ('standard', 'claude-sonnet-5-5', 200000, 40, true),
    ('deep', 'claude-opus-5-5', 500000, 100, true)
  ) AS built_in("id", "model", "max_tokens_per_review", "max_files", "allow_repo_exploration") ON built_in."id" = p."id"
  WHERE built_in."id" IS NULL
    OR p."model" IS DISTINCT FROM built_in."model"
    OR p."max_tokens_per_review" IS DISTINCT FROM built_in."max_tokens_per_review"
    OR p."max_files" IS DISTINCT FROM built_in."max_files"
    OR p."allow_repo_exploration" IS DISTINCT FROM built_in."allow_repo_exploration";
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'Review profiles differ from the built-in depths and would be lost: %', offending
      USING HINT = 'Reset them to the built-in values (or move their repos to a built-in profile and delete them), then migrate again.';
  END IF;
END $$;--> statement-breakpoint
CREATE TYPE "public"."review_depth" AS ENUM('quick', 'standard', 'deep');--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "review_depth" "review_depth" DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "review_runs" ADD COLUMN "depth" "review_depth";--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "depth" "review_depth";--> statement-breakpoint
-- Profile IDs are the depths one to one; history from anything else keeps no depth.
UPDATE "repositories" SET "review_depth" = "profile_id"::"review_depth" WHERE "profile_id" IN ('quick', 'standard', 'deep');--> statement-breakpoint
UPDATE "review_runs" SET "depth" = "profile_id"::"review_depth" WHERE "profile_id" IN ('quick', 'standard', 'deep');--> statement-breakpoint
UPDATE "reviews" SET "depth" = "profile_id"::"review_depth" WHERE "profile_id" IN ('quick', 'standard', 'deep');--> statement-breakpoint
ALTER TABLE "repositories" DROP CONSTRAINT "repositories_organization_profile_fk";--> statement-breakpoint
ALTER TABLE "repositories" DROP COLUMN "profile_id";--> statement-breakpoint
ALTER TABLE "review_runs" DROP COLUMN "profile_id";--> statement-breakpoint
ALTER TABLE "review_runs" DROP COLUMN "profile_name";--> statement-breakpoint
ALTER TABLE "reviews" DROP COLUMN "profile_id";--> statement-breakpoint
DROP TABLE "review_profiles" CASCADE;
