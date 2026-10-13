ALTER TABLE "repositories" ALTER COLUMN "enabled" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "repositories" ALTER COLUMN "enabled" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "repositories" ALTER COLUMN "ralph_enabled" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "repositories" ALTER COLUMN "ralph_enabled" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "query_enabled" boolean;--> statement-breakpoint
-- Every existing repository inherits the organization's allowed task types.
UPDATE "repositories" SET "enabled" = NULL, "ralph_enabled" = NULL, "query_enabled" = NULL;
