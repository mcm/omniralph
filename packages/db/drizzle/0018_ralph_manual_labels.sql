ALTER TABLE "repositories" ALTER COLUMN "ralph_settings" SET DEFAULT '{"openPullRequestEarly":false,"setupCommand":null,"model":"opus","manualLabels":["manual"]}'::jsonb;--> statement-breakpoint
UPDATE "repositories" SET "ralph_settings" = "ralph_settings" || '{"manualLabels":["manual"]}'::jsonb WHERE NOT ("ralph_settings" ? 'manualLabels');
