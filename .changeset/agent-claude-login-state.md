---
"@omniralph/agent": minor
---

Agents report whether Claude is signed in. Every heartbeat now says whether the agent's Claude login works (signed in, signed out, or unknown when the check timed out) and where its credentials come from (the `claude` login, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, or a third-party provider such as Bedrock). The account's email and organization stay on the machine.
