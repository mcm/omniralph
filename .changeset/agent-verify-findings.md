---
"@omniralph/agent": patch
---

Add the built-in `builtin:verify-findings` verifier: a read-only query playbook that checks a review pass's findings in a fresh session over a checkout of the head, confirming or rejecting each one with the line it relies on, and naming the areas the pass didn't reach. `applyFindingVerification` keeps only confirmed findings, dropping and counting rejected and unanswered ones, and keeps a pass's findings unverified with a warning when the verifier fails (a rate limit retries). Reviews don't invoke it yet.
