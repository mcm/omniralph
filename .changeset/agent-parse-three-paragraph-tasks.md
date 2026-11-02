---
"@omniralph/agent": patch
---

Tasks are read in the three-paragraph shape ("I want you to …", "Build it by …", "Don't stop until …"): paragraph 1 is the story's description, paragraph 2 its approach and paragraph 3 its acceptance criteria (one per list item, or one per sentence of prose), and a task is a Fix when it carries a fix label. The story payload carries the approach in its own `approach` field. The interim story and fix formats are no longer read as tasks; legacy PRDs read as before. Triage results are checked against the three-paragraph shape.
