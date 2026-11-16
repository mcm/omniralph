---
"@omniralph/agent": minor
---

Query runs download the run spec's `attachments` too: the rounds of a feature's sharding (the worker drafting the epics and the verifier judging them) now get the files attached to the feature. The agent downloads them into a temporary folder outside any checkout before anything else (a failed download fails the run, naming the file and why), lets the session read it, keeping the file tools for it even when the run's ref can't be checked out, gives the prompt their list as the new `attachedFiles` template variable, and deletes the folder after the run. The built-in `builtin:shard-plan` and `builtin:verify-shard` prompts list them under **Attached files**.
