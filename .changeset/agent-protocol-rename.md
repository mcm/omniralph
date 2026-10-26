---
"@omniralph/agent": patch
---

The agent talks to the control panel under `/api/agent/*`, with agent-named tokens (audience `omniralph-agent`), enrollment (`agentId`) and wake channel (`agent:<id>`), and reads its Omniralph tools from the run spec's `tools.agent`. It needs a control panel with the same rename: old `@omniralph/harness` installs can't talk to it.
