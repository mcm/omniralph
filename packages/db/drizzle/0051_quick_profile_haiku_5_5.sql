-- Move the built-in Quick profile to Haiku 5.5, unless an admin already picked another model.
UPDATE "review_profiles" SET "model" = 'claude-haiku-5-5', "updated_at" = now() WHERE "id" = 'quick' AND "built_in" = true AND "model" = 'claude-haiku-4-5';
