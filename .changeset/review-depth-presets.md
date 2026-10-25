---
"@omniralph/harness": patch
---

Reviews run at a review depth (Quick, Standard or Deep) instead of an editable review profile. `@omniralph/shared` exports the presets as `REVIEW_DEPTHS`; a review's `reviewConfig.profile` now carries its depth's preset, so the agent's review lifecycle is unchanged. Posted review summaries say **Depth** instead of **Profile**.
