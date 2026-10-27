CREATE TYPE "public"."chat_web_message_author" AS ENUM('user', 'om');--> statement-breakpoint
CREATE TYPE "public"."chat_web_message_status" AS ENUM('streaming', 'complete');--> statement-breakpoint
ALTER TYPE "public"."chat_platform" ADD VALUE 'web';--> statement-breakpoint
CREATE TABLE "chat_web_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"author" "chat_web_message_author" NOT NULL,
	"user_id" text,
	"markdown" text DEFAULT '' NOT NULL,
	"status" "chat_web_message_status" DEFAULT 'complete' NOT NULL,
	"card" jsonb,
	"card_ref" jsonb,
	"thread_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "repository_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "branch" text;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "started_by_user_id" text;--> statement-breakpoint
ALTER TABLE "chat_web_messages" ADD CONSTRAINT "chat_web_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_web_messages" ADD CONSTRAINT "chat_web_messages_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_web_messages" ADD CONSTRAINT "chat_web_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_web_messages" ADD CONSTRAINT "chat_web_messages_thread_run_id_chat_thread_runs_id_fk" FOREIGN KEY ("thread_run_id") REFERENCES "public"."chat_thread_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_web_messages_thread_id_created_at_idx" ON "chat_web_messages" USING btree ("thread_id","created_at");--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_started_by_user_id_users_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_threads_started_by_user_id_organization_id_updated_at_idx" ON "chat_threads" USING btree ("started_by_user_id","organization_id","updated_at");