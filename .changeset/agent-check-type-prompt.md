---
"@omniralph/agent": patch
---

Render a review prompt for one check type: `buildPrompt` and `reviewVariables` take a `checkType`, ending the prompt with the check type's focus and only its categories' rubric sections plus the shared ones, after the content every pass shares (`renderCheckRubric`, `filterRubric`, `parseRubric`). Single-pass prompts are unchanged, and reviews don't run check-type passes yet.
