-- Built-in review profiles. Repositories default to `standard`.
-- Quick reviews only the diff; Standard and Deep may explore the repository.
INSERT INTO "review_profiles" ("id", "name", "description", "model", "max_tokens_per_review", "max_files", "allow_repo_exploration", "built_in")
VALUES
  ('quick', 'Quick', 'Fast, diff-only review for small changes.', 'claude-haiku-4-5', 60000, 15, false, true),
  ('standard', 'Standard', 'Balanced review with repository exploration.', 'claude-sonnet-5-5', 200000, 40, true, true),
  ('deep', 'Deep', 'Thorough review for large or high-risk changes.', 'claude-opus-5-5', 500000, 100, true, true)
ON CONFLICT ("id") DO NOTHING;
