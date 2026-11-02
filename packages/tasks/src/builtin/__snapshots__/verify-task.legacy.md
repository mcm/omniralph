A session working through "Widgets" (ENG-600) reported the task below complete, and its checks passed. Before the task counts as done, check the change against each of its acceptance criteria.

## Task: ENG-602 - Sort widgets
### Description
```markdown
Sort the widgets.
```

### Acceptance Criteria
A criterion is evidence to check, not a test to demand: it holds when the code, a command's output or an existing test shows it. A test that only asserts a file exists or what a config contains doesn't show a criterion holds.
- ```
Widgets sort by name
```

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
1. The working directory is a checkout of the task's commit `3333333333333333333333333333333333333333` on `omniralph/eng-600-widgets`. Read what it changed: `git show --stat 3333333333333333333333333333333333333333`, then `git show 3333333333333333333333333333333333333333`, opening files where the diff alone isn't clear.
2. For each acceptance criterion, decide whether the code meets it:
   - Accept it when the change (or code already there) does what it says. Give the evidence in one or two sentences, naming the files or tests.
   - Send it back when it isn't met, or is only partly met. Say concretely what is missing or wrong, so the next session can fix it without guessing.
   - Judge what the criterion asks for, not how you would have built it. Style preferences, refactors and work outside the task are never a reason to send a criterion back.
3. Don't change any files.

Report one entry per criterion in `criteria` (`criterion` as written above, `accepted`, and the `reason`), and a short `summary` of your verdict.