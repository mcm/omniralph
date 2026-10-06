CREATE TYPE "public"."ui_theme" AS ENUM('light', 'dark');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "theme" "ui_theme";