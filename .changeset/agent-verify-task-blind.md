---
"@omniralph/agent": patch
---

The task verifier checks a three-paragraph task blind to how it was built: its prompt shows paragraph 1 ("What to Build", or "What Is Broken" for a Fix), paragraph 3's criteria under "Don't Stop Until" and the commit's diff (a `diff` setup command, without the commit message), and tells it not to read commit messages. Paragraph 2 and the builder's summary never reach it. The verify payload says whether the story is a task (`task`) and its `kind`. Legacy stories are verified as before.
