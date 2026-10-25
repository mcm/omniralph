---
"@omniralph/harness": patch
---

A run's model and token budget come from one place. A review takes both from its review depth; every other run takes the task's model, else the agent's, else the Claude Code default, and the task's fixed token budget or no limit. A task's token budget is now `{ tokens }` or `null` ("No limit"): `profileFraction` is gone, and review tasks can't set a model or budget. The built-in `ask-about-code`, `correlate-findings`, `reply-to-finding` and `learn-rule` tasks set `claude-sonnet-5-5` and fixed budgets (50,000, 100,000, 20,000 and 5,000 tokens), so their runs keep today's model and budget.
