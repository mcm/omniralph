---
"@omniralph/agent": minor
---

Slots and accepted kinds are set on the agent and reported to the control panel. The agent's slots (`maxConcurrency`) and its coding and review pool limits come from `settings.json` only (the heartbeat response no longer carries `maxConcurrency` or `poolLimits`). A change applies at once: the agent re-checks what it claims (lowering a limit cancels nothing) and sends a heartbeat right away. Every heartbeat reports `local { maxConcurrency, poolLimits, versionPin, installablesAllow }`, which the control panel stores read-only and shows on Fleet.
