ALTER TABLE "reviews" ADD COLUMN "pr_title" text;--> statement-breakpoint
CREATE INDEX "reviews_repository_created_at_idx" ON "reviews" USING btree ("repository_id","created_at");