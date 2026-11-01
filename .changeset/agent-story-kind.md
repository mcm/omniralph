---
"@omniralph/agent": minor
---

Story jobs now carry the story's kind (`story.kind`: `fix` when the work item has one of the tracker's fix labels, else `story`), and the story prompt says it on one line under the issue line ("Kind: Fix" or "Kind: Story"), through the new `story.kind` template variable.
