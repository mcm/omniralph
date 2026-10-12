CREATE TABLE "chat_channel_task_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"channel_id" text NOT NULL,
	"ask_about_code_task_id" text,
	"start_work_task_id" text,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_channel_task_settings" ADD CONSTRAINT "chat_channel_task_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_channel_task_settings" ADD CONSTRAINT "chat_channel_task_settings_connection_id_chat_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."chat_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_channel_task_settings" ADD CONSTRAINT "chat_channel_task_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_channel_task_settings_connection_id_channel_id_uq" ON "chat_channel_task_settings" USING btree ("connection_id","channel_id");--> statement-breakpoint
CREATE INDEX "chat_channel_task_settings_organization_id_idx" ON "chat_channel_task_settings" USING btree ("organization_id");