---
"@omniralph/agent": patch
---

Render a review prompt for one check type: `buildPrompt` and `reviewVariables` take a `checkType`, adding the check type's focus and keeping only its categories' rubric sections plus the shared ones (`renderCheckRubric`, `filterRubric`, `parseRubric`). Single-pass prompts are unchanged, and reviews don't run check-type passes yet.
