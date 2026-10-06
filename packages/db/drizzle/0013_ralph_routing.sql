ALTER TABLE "repositories" ADD COLUMN "ralph_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "linear_team_keys" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "linear_project_names" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "linear_labels" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "ralph_settings" jsonb DEFAULT '{"openPullRequestEarly":false,"setupCommand":null,"model":"opus"}'::jsonb NOT NULL;