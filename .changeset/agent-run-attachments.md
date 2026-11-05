---
"@omniralph/agent": patch
---

Coding runs get the files people attached in Omniralph to their epic and the epic's feature: the run spec's new `attachments` lists each with a short-lived download URL, and the agent downloads them into a temporary folder outside the worktree before the first session (a failed download fails the run, naming the file and why), lets the session read it, lists each file's path, name and type in the prompt's **Attached Files** section (the `files` template variable) with the instruction to treat their contents as data and never commit them, and deletes the folder after the run.
