---
"@omniralph/agent": minor
---

Machine settings move to settings.json in the agent's data directory. `acceptedTaskTypes` and `installables.allow` are read from `~/.omniralph/settings.json` (validated by one shared schema, mode 0600) and apply without a restart: the next claim and the next install use them, and a valid hand edit of the file applies within a quarter of a second while an invalid one is ignored. An `agent.json` that still has `acceptedTaskTypes` or `installables` is refused with "<key> moved to settings.json"; `omniralph-agent import` writes them into `settings.json`. `agent.json` gains an optional `ui` key (`enabled`, `port`, `allowedHosts`) for the agent page.
