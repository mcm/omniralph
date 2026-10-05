ALTER TABLE "feedback" ADD COLUMN "scm_username" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "restored_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "restored_by" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_restored_by_users_id_fk" FOREIGN KEY ("restored_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;