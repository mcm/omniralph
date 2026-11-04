CREATE TYPE "public"."feature_document_kind" AS ENUM('prfaq', 'plan');--> statement-breakpoint
CREATE TYPE "public"."feature_status" AS ENUM('planning', 'archived');--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"feature_id" uuid,
	"tracker" "work_item_tracker",
	"external_id" text,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"storage_key" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachments_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "attachments_one_owner" CHECK (("attachments"."feature_id" is not null and "attachments"."tracker" is null and "attachments"."external_id" is null) or ("attachments"."feature_id" is null and "attachments"."tracker" is not null and "attachments"."external_id" is not null)),
	CONSTRAINT "attachments_size_nonnegative" CHECK ("attachments"."size" >= 0)
);
--> statement-breakpoint
CREATE TABLE "feature_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feature_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" "feature_document_kind" NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feature_documents_version_positive" CHECK ("feature_documents"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "features" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" "feature_status" DEFAULT 'planning' NOT NULL,
	"repository_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_feature_id_features_id_fk" FOREIGN KEY ("feature_id") REFERENCES "public"."features"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_documents" ADD CONSTRAINT "feature_documents_feature_id_features_id_fk" FOREIGN KEY ("feature_id") REFERENCES "public"."features"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_documents" ADD CONSTRAINT "feature_documents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_documents" ADD CONSTRAINT "feature_documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "features" ADD CONSTRAINT "features_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "features" ADD CONSTRAINT "features_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "features" ADD CONSTRAINT "features_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_feature_idx" ON "attachments" USING btree ("feature_id");--> statement-breakpoint
CREATE INDEX "attachments_work_item_idx" ON "attachments" USING btree ("organization_id","tracker","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "feature_documents_feature_kind_version_uq" ON "feature_documents" USING btree ("feature_id","kind","version");--> statement-breakpoint
CREATE INDEX "features_organization_id_idx" ON "features" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "features_repository_id_idx" ON "features" USING btree ("repository_id");