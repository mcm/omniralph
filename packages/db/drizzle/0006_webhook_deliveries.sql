CREATE TABLE "webhook_deliveries" (
	"provider" "scm_provider" NOT NULL,
	"delivery_id" text NOT NULL,
	"repository_id" uuid,
	"job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_provider_delivery_id_pk" PRIMARY KEY("provider","delivery_id")
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_created_at_idx" ON "webhook_deliveries" USING btree ("created_at");