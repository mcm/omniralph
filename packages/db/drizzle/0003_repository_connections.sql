ALTER TABLE "repositories" ADD COLUMN "webhook_id" text;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "disconnected_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "scm_connections_provider_base_url_external_id_uq" ON "scm_connections" USING btree ("provider","base_url","external_id");