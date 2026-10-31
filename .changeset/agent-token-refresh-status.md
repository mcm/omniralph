---
"@omniralph/agent": patch
---

Report failing access-token refreshes in the heartbeat (`tokenRefresh`: since when, how many attempts, the last error and when the access and refresh tokens expire), so Fleet can warn before the agent goes offline.
