CREATE TYPE "public"."documentation_check" AS ENUM('off', 'comment', 'update');--> statement-breakpoint
CREATE TYPE "public"."documentation_depth" AS ENUM('quick', 'standard', 'deep');--> statement-breakpoint
CREATE TYPE "public"."documentation_update_targets" AS ENUM('omniralph', 'same-repo');--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "documentation_check" "documentation_check" DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "documentation_depth" "documentation_depth" DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "documentation_update_targets" "documentation_update_targets" DEFAULT 'omniralph' NOT NULL;