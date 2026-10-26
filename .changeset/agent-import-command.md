---
"@omniralph/agent": patch
---

Add `omniralph-agent import`, which brings an `@omniralph/harness` install's config over to the agent, so the machine comes back as the same agent without enrolling again. It works offline, refuses while the old daemon runs, and never prints the refresh token. `omniralph-agent start` without a config now points to `import` when an old install's config exists.
