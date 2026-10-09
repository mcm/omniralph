CREATE TABLE "chat_link_state_uses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "chat_link_state_uses_expires_at_idx" ON "chat_link_state_uses" USING btree ("expires_at");