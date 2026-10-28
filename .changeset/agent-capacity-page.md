---
"@omniralph/agent": minor
---

The agent page's Capacity section sets the agent's slots, its coding and review and ask slots and the kinds of work it accepts, saved to `settings.json` through `PUT /api/settings/capacity` and `PUT /api/settings/kinds` against the revision the page read (409 with the current settings when the file changed, 400 with issues for invalid values). Left-out capacity values and kinds mean the defaults.
