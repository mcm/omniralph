-- Renames Om's chat tools `draft_linear_issue` and `delegate_linear_issue` to
-- `draft_tracker_issue` and `delegate_tracker_issue` in recorded chat messages (the AI SDK
-- tool-call and tool-result parts the agent replays as thread history), so older turns
-- name the tools the agent has now.
UPDATE "chat_messages" SET "content" = regexp_replace(
    "content"::text,
    '"toolName": "(draft|delegate)_linear_issue"',
    '"toolName": "\1_tracker_issue"',
    'g'
  )::jsonb
  WHERE "content"::text ~ '"toolName": "(draft|delegate)_linear_issue"';
