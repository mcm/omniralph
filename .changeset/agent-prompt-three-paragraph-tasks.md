---
"@omniralph/agent": patch
---

The story prompt presents a three-paragraph task under its own headings: paragraph 1 as what to build ("What Is Broken" for a Fix), paragraph 2 as how to build it, marked as guidance, and paragraph 3 as the condition to keep working until, with the epic's description as context. A Fix's prompt says the behavior named in paragraph 3 must keep working. The story payload says whether the story is a three-paragraph task (`task`). The `Covers:` requirements list is gone from the prompt; legacy stories render as before.
