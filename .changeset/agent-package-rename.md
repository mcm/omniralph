---
"@omniralph/agent": major
---

Renamed the package from `@omniralph/harness` to `@omniralph/agent`, starting at 2.0.0 to match Omniralph 2.0. The binary is now `omniralph-agent`, its config is `~/.config/omniralph/agent.json` (`OMNIRALPH_AGENT_CONFIG` overrides it) and its logs are named `omniralph-agent`. Self-update can't cross the rename: on each existing machine, install `@omniralph/agent` fresh with `npm install -g @omniralph/agent`, then run `omniralph-agent import` to bring the machine back as the same agent without enrolling it again.
