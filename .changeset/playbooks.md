---
"@omniralph/harness": patch
---

Agent and task definitions are merged into playbooks: one recipe per kind of run (role, prompts, model, tools, requirements). The control panel still sends each run as an agent and a task, built from the playbook, so runs work as before. The run spec's agent no longer has task types or skills; fields the harness doesn't know are passed through.
