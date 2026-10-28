---
"@omniralph/agent": minor
---

The agent keeps a rotating log in its data directory. Besides stderr, it writes `<dataDir>/logs/agent.log` (directory 0700, files 0600), rotated at 10 MB keeping `agent.log.1` … `agent.log.5`, and keeps the last 2,000 lines in memory for the agent's page. Tokens, `Authorization` headers and environment maps are redacted on every target.
