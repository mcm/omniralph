ALTER TABLE "users" ADD COLUMN "sound_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "sound_volume" real DEFAULT 0.7 NOT NULL;