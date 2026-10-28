---
"@omniralph/agent": minor
---

The agent remembers what it ran: the last 200 finished attempts are kept in `<dataDir>/state/attempts.json` (0600), each labeled in the same plain words as the control panel ("Built SOC-1720", "Synced customer-portal"), and a running attempt's Claude transcript is kept in memory (the last 2,000 events, dropped 10 minutes after it finishes) for the agent's page.
