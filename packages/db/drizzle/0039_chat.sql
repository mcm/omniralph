CREATE TYPE "public"."chat_identity_source" AS ENUM('manual', 'email');--> statement-breakpoint
CREATE TYPE "public"."chat_message_role" AS ENUM('user', 'assistant', 'tool');--> statement-breakpoint
CREATE TYPE "public"."chat_platform" AS ENUM('slack', 'discord');--> statement-breakpoint
CREATE TABLE "chat_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"platform" "chat_platform" NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"encrypted_credentials" text,
	"installed_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_identities" (
	"organization_id" uuid NOT NULL,
	"platform" "chat_platform" NOT NULL,
	"external_user_id" text NOT NULL,
	"user_id" text NOT NULL,
	"source" "chat_identity_source" NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_identities_organization_id_platform_external_user_id_pk" PRIMARY KEY("organization_id","platform","external_user_id")
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"role" "chat_message_role" NOT NULL,
	"external_user_id" text,
	"author_name" text,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"platform" "chat_platform" NOT NULL,
	"external_thread_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"started_by_external_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_user_profiles" (
	"connection_id" uuid NOT NULL,
	"external_user_id" text NOT NULL,
	"email" text,
	"display_name" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_user_profiles_connection_id_external_user_id_pk" PRIMARY KEY("connection_id","external_user_id")
);
--> statement-breakpoint
ALTER TABLE "chat_connections" ADD CONSTRAINT "chat_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_connections" ADD CONSTRAINT "chat_connections_installed_by_user_id_users_id_fk" FOREIGN KEY ("installed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_identities" ADD CONSTRAINT "chat_identities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_identities" ADD CONSTRAINT "chat_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_connection_id_chat_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."chat_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_user_profiles" ADD CONSTRAINT "chat_user_profiles_connection_id_chat_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."chat_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_connections_platform_external_id_uq" ON "chat_connections" USING btree ("platform","external_id");--> statement-breakpoint
CREATE INDEX "chat_connections_organization_id_idx" ON "chat_connections" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "chat_identities_user_id_idx" ON "chat_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "chat_messages_thread_id_created_at_idx" ON "chat_messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_threads_connection_id_external_thread_id_uq" ON "chat_threads" USING btree ("connection_id","external_thread_id");--> statement-breakpoint
CREATE INDEX "chat_threads_organization_id_idx" ON "chat_threads" USING btree ("organization_id");