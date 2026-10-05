# Review evals

`pnpm eval` measures how well reviews find real problems and how much they
cost. It runs the real review (`runReview` with `ClaudeAgentProvider`, exactly
what an agent runs) over a corpus of small known-bad and known-clean changes
and reports, per profile:

- **precision**: how many reported findings were real (TP / (TP + FP)),
- **recall**: how many known problems were found (TP / (TP + FN)),
- **false positives on clean cases**: findings on changes that should get none,
- **tokens** in and out per case (mean, p50, max) and duration,

each compared against the committed baseline (`evals/baseline.json`). Use it
whenever you change the rubric, the prompts, the provider or a profile, to tell
whether reviews got better or only cheaper.

> `pnpm eval` spends real Claude tokens (a full run is 27 cases × 3 profiles,
> Deep on Opus). It is not part of `pnpm test` or CI. The offline tests
> (`packages/engine/src/eval/*.test.ts`) check the harness and the corpus with
> a recorded fake provider.

## Running

Prerequisites: `pnpm install`, `git` ≥ 2.40, and Claude Code auth on this
machine, the same as an agent host: a `claude` login, or `ANTHROPIC_API_KEY` /
`CLAUDE_CODE_OAUTH_TOKEN` in the environment (see
[docs/claude-auth.md](../docs/claude-auth.md)).

```bash
pnpm eval                                   # every profile, every case
pnpm eval --profile quick                   # one profile: quick | standard | deep | all
pnpm eval --case bad-sql-concat --case clean-docs
pnpm eval --max-total-tokens 2000000        # hard cap for the whole run
pnpm eval --profile standard --update-baseline
```

| Option                   | Default        | Meaning                                                                                                                                                                                   |
| ------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--profile`              | `all`          | Profiles to run. They use the built-in defaults from `packages/engine/src/eval/profiles.ts` (the same as the seed migration), not a database's edited copies.                             |
| `--case <id>`            | every case     | Run only these cases (repeat the flag, or separate IDs with commas).                                                                                                                      |
| `--max-total-tokens <n>` | no cap         | Each case's budget is capped at what's left of `n`. When the cap cuts a case short, or nothing is left, the run stops, writes the report for what ran and exits with code 2.              |
| `--update-baseline`      | off            | Overwrite this run's profiles in `evals/baseline.json` (other profiles keep their entries). Refused with `--case` and skipped when the run aborted, so the baseline is always a full run. |
| `--evals-dir <dir>`      | `<repo>/evals` | Another corpus.                                                                                                                                                                           |

Each case is reviewed like a fresh pull request: the full diff, no previous
review, no custom instructions or repository rules. Progress goes to stderr;
the Markdown report goes to stdout. Ctrl-C cancels the current case, stops the run and
still writes the report.

## Reading the report

Every run writes `evals/reports/<timestamp>-<profile>.json` and `.md`
(gitignored; `<profile>` is the `--profile` argument). The Markdown has, per
profile:

1. A line with the scored cases, TP/FP/FN, clean cases flagged, total tokens and time.
2. A metrics table: **Current**, **Baseline** and **Δ** (current − baseline).
   Precision and recall deltas are in percentage points. Higher precision and
   recall are better; fewer false positives and tokens are better. If the
   baseline was measured over a different case set, the report says so and the
   deltas are only indicative.
3. A per-case table: stop reason, TP, FP, FN, tokens in/out and duration.
4. **Misses and false positives**: every false positive (with why it counted:
   `unmatched`, `duplicate` or `must_not_flag`) and every missed expected
   finding, so you can open the case and see what happened.

The JSON has the same data plus every finding (path, lines, severity,
category, title, confidence and verdict) for scripting and diffing two runs.

How findings are scored (`scoreCase` in `packages/engine/src/eval/score.ts`):

- A finding **matches** an expected item when the path is the same, the line
  ranges overlap within ±3 lines, the category is the same and the severity is
  at least `minSeverity` (`info` < `low` < `medium` < `high` < `critical`).
  Each expected item is matched once; a second finding for it is a
  `duplicate` false positive.
- A finding touching a `mustNotFlag` range (exact lines, no tolerance; no
  lines = the whole file) is always a false positive.
- Every other finding is an `unmatched` false positive. Expected items nobody
  matched are false negatives.
- Cases that stopped with `error` or `rate_limited`, or that `--max-total-tokens`
  cut short (`aborted`), are listed but left out of the metrics ("unscored").
  A case that ran out of its _profile's_ budget (`budget_exhausted`) is scored:
  that's a real outcome of the profile.

Model output varies between runs. Treat a change of one finding on one case as
noise; look for consistent movement, and rerun the affected cases
(`--case …`) before concluding.

### Updating the baseline

After a change you mean to keep, run the full corpus for the profiles you
changed with `--update-baseline` and commit `evals/baseline.json` along with
the change, so the next comparison starts from it. Mention the deltas in the
pull request.

## Cases

```
evals/cases/<case-id>/
  base/          the source tree before the change (kept small)
  change.patch   a git patch applied to base/ to produce the head
  case.json
```

`buildCaseRepo` (`packages/engine/src/eval/repo.ts`) turns a case into a temp
git repo: `base/` is committed on `main`, then the patch is applied with
`git apply --index` and committed as the head.

`case.json`:

```json
{
  "description": "What the case tests and why (never shown to the reviewer).",
  "language": "typescript",
  "tags": ["security", "sql-injection"],
  "pr": { "title": "Add user search endpoint", "description": "Optional PR body." },
  "expected": [
    {
      "path": "src/users/repository.ts",
      "startLine": 17,
      "endLine": 20,
      "category": "security",
      "minSeverity": "high"
    }
  ],
  "mustNotFlag": [
    {
      "path": "src/routes/users.ts",
      "startLine": 8,
      "endLine": 11,
      "note": "Input is validated here."
    }
  ]
}
```

- `pr` is what the reviewer sees as the pull request. Write it like an author
  would; don't give the answer away.
- `expected` lines are 1-based lines of the **head** version of the file, and
  the whole range must be inside one hunk of the diff (added or context
  lines), like a real finding. For a removal, use the context lines around it.
  `category` is one of the rubric categories (`security`, `correctness`,
  `concurrency`, `resources`, `error-handling`, `performance`,
  `breaking-change`, `tests`). `expected` is empty for a clean case.
- `mustNotFlag` (optional) marks code that looks suspicious but is correct;
  `startLine`/`endLine` are optional (without them the whole file is off
  limits).
- Name bad cases `bad-<pattern>` and clean ones `clean-<what>`; tag bad cases
  with the pattern (`sql-injection`, `floating-promise`, …).

### Adding a case

1. Write the smallest tree that makes the problem (or its correct counterpart)
   realistic: the changed files plus the context a reviewer needs to judge
   them. Put it in `base/`.
2. Make the change in a scratch copy and produce the patch with git:

   ```bash
   cd "$(mktemp -d)" && cp -R ~/omniralph/evals/cases/<case-id>/base/. . \
     && git init -q && git add -A && git commit -qm base
   # …edit files to the head version…
   git add -A && git diff --cached --no-color > ~/omniralph/evals/cases/<case-id>/change.patch
   ```

3. Write `case.json`, reading the line numbers from the head version
   (`grep -n`, or `git show HEAD:<path> | cat -n` after committing).
4. Run `pnpm --filter @omniralph/engine test`. The corpus test builds every
   case and fails if a patch doesn't apply, an `expected` range is outside the
   diff, a `mustNotFlag` path is missing, or the corpus lost a required
   pattern.
5. Run `pnpm eval --case <case-id>` to see how each profile does, then
   refresh the baseline with a full run (`--update-baseline`), since the case
   set changed.

Don't run Prettier or other formatters over `evals/cases` (it's in
`.prettierignore`): `base/` must stay byte-for-byte what `change.patch`
expects.

### Turning a dismissed false positive into a regression case

Every false positive someone dismisses in the control panel or with
`@bot dismiss` is a free clean case. To keep it from coming back:

1. Open the review (**Reviews › review**, or the link in the summary
   comment). Note the finding's file and lines, the dismissal reason and note,
   and the review's base and head SHAs.
2. Reduce the change to a minimal reproduction: check out the base SHA, copy
   the flagged file and whatever context it needs into `base/` (strip
   unrelated code, secrets and anything that shouldn't live in this repo),
   then reproduce the change and write `change.patch` as above. Keep the
   flagged lines' shape so the same false positive can happen.
3. Write `case.json` as a clean case (`clean-fp-<short-name>`): `expected: []`
   and a `mustNotFlag` entry for the flagged lines whose `note` says why the
   finding was wrong (the dismissal note is a good start). If the same change
   has a real problem too, add it to `expected` and name the case `bad-…`.
4. Follow steps 4–5 of _Adding a case_. The case should fail (an FP on the
   `mustNotFlag` lines) with the rubric that produced the false positive; that
   proves the case reproduces it. Then fix the rubric or prompt, rerun, and
   commit the case, the fix and the new baseline together.

Learned rules (generated from dismissals) are per repository and aren't
applied in evals, so a case passing here means the base review no longer makes
the mistake, not that a rule hides it.
