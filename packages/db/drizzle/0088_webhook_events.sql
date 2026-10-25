CREATE TYPE "public"."webhook_event_outcome" AS ENUM('started_run', 'updated_run', 'ignored', 'failed', 'duplicate');--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" "webhook_provider" NOT NULL,
	"scm_connection_id" uuid,
	"integration_id" uuid,
	"repository_id" uuid,
	"delivery_id" text,
	"event" text NOT NULL,
	"payload" jsonb,
	"payload_truncated" boolean DEFAULT false NOT NULL,
	"outcome" "webhook_event_outcome" NOT NULL,
	"reason_code" text,
	"reason" text,
	"run_id" uuid,
	"run_kind" text,
	"replay_of_id" uuid,
	"replayed_by" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_events_source" CHECK (("webhook_events"."scm_connection_id" is null) <> ("webhook_events"."integration_id" is null))
);
--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_scm_connection_id_scm_connections_id_fk" FOREIGN KEY ("scm_connection_id") REFERENCES "public"."scm_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_replay_of_id_webhook_events_id_fk" FOREIGN KEY ("replay_of_id") REFERENCES "public"."webhook_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_replayed_by_users_id_fk" FOREIGN KEY ("replayed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_events_scm_connection_received_at_idx" ON "webhook_events" USING btree ("scm_connection_id","received_at");--> statement-breakpoint
CREATE INDEX "webhook_events_integration_received_at_idx" ON "webhook_events" USING btree ("integration_id","received_at");--> statement-breakpoint
CREATE INDEX "webhook_events_received_at_idx" ON "webhook_events" USING btree ("received_at");