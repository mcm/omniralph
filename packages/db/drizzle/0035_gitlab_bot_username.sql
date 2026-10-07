-- A GitLab connection's bot `@` handle is its token user's username. Existing
-- connections are named `<username> @ <host>`: take the part before " @ ".
ALTER TABLE "scm_connections" ADD COLUMN "bot_username" text;--> statement-breakpoint
UPDATE "scm_connections" SET "bot_username" = split_part("name", ' @ ', 1) WHERE "provider" = 'gitlab' AND position(' @ ' in "name") > 0;
