---
"@omniralph/agent": minor
---

Host tool paths are set on the agent; the organization catalog is gone. The agent reads them from `settings.json` (`hostTools`) and checks every configured tool and every tool the control panel's new `requiredHostTools` (the names the organization's playbooks require) asks about: a configured path is used when it's an executable outside `blockedExecPaths`, a tool without one is looked up on the agent's `PATH`, and a configured path that is missing, not executable or blocked makes the tool unavailable. A change applies at once and is reported with an immediate heartbeat as `hostTools: { name, path, source, problem }[]`; the heartbeat response no longer carries `hostTools`.
