A session working through "Widgets" (ENG-600) reported the task below complete, and its checks passed. Before the task counts as done, check the change against each of its acceptance criteria.

## Task: ENG-601 - List widgets
### What to Build
```markdown
I want you to list the widgets on the dashboard, so that operators see what is deployed.
```

### Don't Stop Until
The task is done when every criterion below holds. A criterion is evidence to check, not a test to demand: it holds when the code, a command's output or an existing test shows it. A test that only asserts a file exists or what a config contains doesn't show a criterion holds.
- ```
The dashboard lists every widget by name
```
- ```
Widgets sort by name
```

You get what the task was meant to deliver and its done criteria, not how anyone suggested building it or the builder's account of its work: judge the change on its own.

Background from the epic, for context only (don't check its other requirements; other tasks own them):
<epic-background>
```markdown
## Problem

No widgets.
```
</epic-background>

These checks already passed, so don't run them again:
- `pnpm test`

## Check the change
1. The working directory is a checkout of the task's commit `3333333333333333333333333333333333333333` on `omniralph/eng-600-widgets`. This is what it changed:
```diff
diff --git a/src/widgets.ts b/src/widgets.ts
--- a/src/widgets.ts
+++ b/src/widgets.ts
@@ -1 +1,2 @@
+export const listWidgets = () => db.widgets.orderBy("name");
```
Open files where the diff alone isn't clear (and read the rest with `git diff 3333333333333333333333333333333333333333~1 3333333333333333333333333333333333333333` if it was cut short). Don't read the commit's message or the branch's log (`git log`, or `git show` without `--format=`): they are the builder's account, and you judge the change.
2. For each acceptance criterion, decide whether the code meets it:
   - Accept it when the change (or code already there) does what it says. Give the evidence in one or two sentences, naming the files or tests.
   - Send it back when it isn't met, or is only partly met. Say concretely what is missing or wrong, so the next session can fix it without guessing.
   - Judge what the criterion asks for, not how you would have built it. Style preferences, refactors and work outside the task are never a reason to send a criterion back.
3. Don't change any files.

Report one entry per criterion in `criteria` (`criterion` as written above, `accepted`, and the `reason`), and a short `summary` of your verdict.