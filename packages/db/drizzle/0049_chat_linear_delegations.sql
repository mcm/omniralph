CREATE TABLE "chat_linear_delegations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"linear_issue_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_linear_delegations" ADD CONSTRAINT "chat_linear_delegations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_linear_delegations" ADD CONSTRAINT "chat_linear_delegations_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_linear_delegations_issue_idx" ON "chat_linear_delegations" USING btree ("organization_id","linear_issue_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_linear_delegations_created_at_idx" ON "chat_linear_delegations" USING btree ("created_at");