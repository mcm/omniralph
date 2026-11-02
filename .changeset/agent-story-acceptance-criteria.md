---
"@omniralph/agent": patch
---

Story sessions see their task's acceptance criteria again: the story payload carries them in `story.acceptanceCriteria`, and the agent falls back to parsing the description for payloads without it.
