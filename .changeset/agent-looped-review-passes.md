---
"@omniralph/agent": patch
---

Reviews run as looped check-type passes. A review task run whose trigger context carries a `pass` plans the change's check types (`planCheckPass`, over `planChecks`) and reviews only its check type's files, one session per group, each with the depth's token cap; a later pass reviews the files of the areas earlier passes didn't reach and its prompt lists the findings earlier passes confirmed (`# Earlier passes`). The result names the files the pass reviewed (`pass.files`, empty when the check type doesn't apply to the change).
