ALTER TABLE "sprints" ADD COLUMN "sprint_pr_number" integer;--> statement-breakpoint
ALTER TABLE "sprints" ADD COLUMN "sprint_pr_url" text;--> statement-breakpoint
CREATE INDEX "sprints_repository_pr_idx" ON "sprints" USING btree ("repository_id","sprint_pr_number");