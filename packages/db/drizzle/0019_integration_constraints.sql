CREATE TABLE "oauth_state_uses" (
	"nonce_hash" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "integrations_provider_external_id_uq";--> statement-breakpoint
CREATE INDEX "oauth_state_uses_expires_at_idx" ON "oauth_state_uses" USING btree ("expires_at");--> statement-breakpoint
-- Keep only the most recently updated integration per provider (the code already removed others).
DELETE FROM "integrations" AS "i" USING "integrations" AS "newer"
WHERE "i"."provider" = "newer"."provider"
  AND ("newer"."updated_at", "newer"."id") > ("i"."updated_at", "i"."id");--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_provider_uq" ON "integrations" USING btree ("provider");