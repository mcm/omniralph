---
"@omniralph/agent": minor
---

Pin a version and update now from the agent; the control panel keeps the organization's version policy. The updater's target is, highest first: a local "Update now" (`SelfUpdater.request()`, which `omniralph-agent update` reaches through `update-request.json`), the pin in `settings.json` (`update.pin`), the organization's `desiredVersion`, else none; failed versions are skipped except by "Update now", and a pin changed during the drain is applied once it ends. The heartbeat reports the pin as `local.versionPin`. The heartbeat response no longer carries `updateRequest`, and the heartbeat no longer sends `handledUpdateRequestId`.
