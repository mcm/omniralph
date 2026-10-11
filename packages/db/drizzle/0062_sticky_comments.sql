CREATE TABLE "sticky_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repository_id" uuid NOT NULL,
	"pr_number" integer NOT NULL,
	"task_id" text NOT NULL,
	"comment_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "summary_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sticky_comments" ADD CONSTRAINT "sticky_comments_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sticky_comments_repository_pr_task_uq" ON "sticky_comments" USING btree ("repository_id","pr_number","task_id");