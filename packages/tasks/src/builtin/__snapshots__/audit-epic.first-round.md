Every task of "Task priorities" (ENG-1) is done, and each one was checked against its own acceptance criteria. Before it goes up for review, check the epic as a whole against each of its requirements (audit round 1 of 2).

## Requirements
### FR-1
```
The system must store a priority on every task.
```

### FR-2
```
The system must show each task's priority as a badge.
```

## Tasks done
What each task was built and checked against, so you know where to look:

### ENG-2: Store task priorities
Acceptance criteria:
```
Tasks have a priority, medium by default
```

### ENG-3: Show the badge (in `acme/web`, not this checkout)

The epic, for context:
<epic>
```markdown
## Problem
No priorities.
```
</epic>

## Audit the code
1. The working directory is a checkout of `0123456789abcdef0123456789abcdef01234567`, the head of the epic's work on `omniralph/eng-1-priorities`. Look at what it changed against `main` (`git log --oneline origin/main..HEAD`, `git diff --stat origin/main...HEAD`) and read the code itself.
2. For each requirement, decide whether the code meets it:
   - `met`: the code does what it says. In `evidence`, name the file (and function) or the test that shows it, in one or two sentences. Leave `missing` and `title` empty.
   - `gap`: it isn't met, or only partly. In `missing`, say concretely what is missing or wrong, so a new task can close it without guessing; in `title`, give that task a short imperative title. In `evidence`, say where you looked.
   - A requirement covered only by a task done in another repo counts as met on that task: say so in `evidence`.
   - Judge what the requirement asks for, not how you would have built it. Style, refactors and work the epic doesn't ask for are never a gap.
3. Don't change any files.

Report one entry per requirement in `requirements` (`id` as written above, `status`, `evidence`, `missing` and `title`), and a short `summary` of the audit.