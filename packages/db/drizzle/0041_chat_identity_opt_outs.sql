CREATE TABLE "chat_identity_opt_outs" (
	"organization_id" uuid NOT NULL,
	"platform" "chat_platform" NOT NULL,
	"external_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_identity_opt_outs_organization_id_platform_external_user_id_pk" PRIMARY KEY("organization_id","platform","external_user_id")
);
--> statement-breakpoint
ALTER TABLE "chat_identities" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "chat_identity_opt_outs" ADD CONSTRAINT "chat_identity_opt_outs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;