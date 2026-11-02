# Review evals

`pnpm eval` measures how well reviews find real problems and how much they
cost. It runs the real review over a corpus of small known-bad and
known-clean changes, with one of two strategies (`--strategy`):

- **`single`** (the default): one review task over the whole diff and rubric
  (`runReview` with `ClaudeAgentProvider`, the same pipeline and prompt as a
  single-pass `builtin:review-pr` review task).
- **`looped`**: a looped review in process (`runLoopedReview`), as a review run
  does it: `planChecks` picks the check types (security, stability,
  performance, compatibility) and their files, each check type runs its passes
  with its own rubric sections (one session per group of files), a fresh
  `builtin:verify-findings` session confirms or rejects each pass's findings
  and names the areas it didn't reach, and the next pass covers those, until a
  pass adds no new confirmed finding or the depth's pass cap is reached
  (security runs at least two passes at Deep). The check types' confirmed
  findings are then merged.

It reports, per profile:

- **precision**: how many reported findings were real (TP / (TP + FP)),
- **recall**: how many known problems were found (TP / (TP + FN)),
- **false positives on clean cases**: findings on changes that should get none,
- **tokens** in and out per case (mean, p50, max) and duration,

each compared against the committed baseline (`evals/baseline.json`). Use it
whenever you change the rubric, the prompts, the provider or a profile, to tell
whether reviews got better or only cheaper, and to tune the review depths'
pass caps by comparing looped reviews with single-pass ones. It measures one
review task on its own: other review tasks and a review run's correlation of
their findings aren't part of it.

> `pnpm eval` spends real Claude tokens (a full run is 27 cases × 3 profiles,
> Deep on Opus; a looped run is several sessions per case and check type). It is not part of `pnpm test` or CI. The offline tests
> (`packages/engine/src/eval/*.test.ts`) check the eval runner and the corpus with
> a recorded fake provider.

## Running

Prerequisites: `pnpm install`, `git` ≥ 2.40, and Claude Code auth on this
machine, the same as an agent host: a `claude` login, or `ANTHROPIC_API_KEY` /
`CLAUDE_CODE_OAUTH_TOKEN` in the environment (see
[docs/claude-auth.md](../docs/claude-auth.md)).

```bash
pnpm eval                                   # every profile, every case, single-pass
pnpm eval --strategy looped                 # the same with looped reviews
pnpm eval --profile quick                   # one profile: quick | standard | deep | all
pnpm eval --case bad-sql-concat --case clean-docs
pnpm eval --max-total-tokens 2000000        # hard cap for the whole run
pnpm eval --profile standard --update-baseline
```

`pnpm bench` is an alias for `pnpm eval` and takes the same options. Use it
where a shell guard blocks commands containing the word `eval`, such as an AI
agent session isolated in a worktree.

| Option                   | Default        | Meaning                                                                                                                                                                                                                                 |
| ------------------------ | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--strategy`             | `single`       | `single` (one review task over the whole diff) or `looped` (check-type passes, verified findings, the depth's pass caps). Reports and baseline entries are per strategy.                                                                |
| `--profile`              | `all`          | Profiles to run. They use the built-in defaults from `packages/engine/src/eval/profiles.ts` (the same as the seed migration), not a database's edited copies.                                                                           |
| `--case <id>`            | every case     | Run only these cases (repeat the flag, or separate IDs with commas).                                                                                                                                                                    |
| `--max-total-tokens <n>` | no cap         | Each case's budget is capped at what's left of `n`. When the cap cuts a case short, or nothing is left, the run stops, writes the report for what ran and exits with code 2.                                                            |
| `--update-baseline`      | off            | Overwrite this run's profiles of this run's strategy in `evals/baseline.json` (other profiles and the other strategy keep their entries). Refused with `--case` and skipped when the run aborted, so the baseline is always a full run. |
| `--evals-dir <dir>`      | `<repo>/evals` | Another corpus.                                                                                                                                                                                                                         |

Each case is reviewed like a fresh pull request: the full diff, no previous
review, no custom instructions or repository rules.

### Looped runs

A looped run uses each depth's pass settings from
`packages/shared/src/review-depth.ts` (`maxPasses`, `verifyFindings`,
`securityMinPasses`): each pass of a check type may spend the depth's token
cap, split between its groups of files, and each verification runs on the
`builtin:verify-findings` playbook's model and token cap. `--max-total-tokens`
caps the whole case: each session gets at most what's left of it. Two
differences from a review run, both because an eval runs on your machine
without a sandbox:

- The verifier gets the read-only tools of a review (`Read`, `Grep`, `Glob`)
  and no shell, so the diff of the pass's files is quoted in its prompt
  instead of it running `git diff`.
- The merge is deterministic: a finding repeating another check type's (same
  path and category, overlapping lines) is dropped, where a review run asks
  its correlation task to merge them. Progress goes to stderr;
  the Markdown report goes to stdout. Ctrl-C cancels the current case, stops the run and
  still writes the report.

## Reading the report

Every run writes `evals/reports/<timestamp>-<strategy>-<profile>.json` and
`.md` (gitignored; `<strategy>` and `<profile>` are the `--strategy` and
`--profile` arguments). The Markdown has, per profile:

1. A line with the scored cases, TP/FP/FN, clean cases flagged, total tokens and time.
2. A metrics table: **Current**, **Baseline** and **Δ** (current − baseline).
   The baseline is the entry of the same strategy and profile: a looped run is
   never compared with a single-pass baseline, or the other way round.
   Precision and recall deltas are in percentage points. Higher precision and
   recall are better; fewer false positives and tokens are better. If the
   baseline was measured over a different case set, the report says so and the
   deltas are only indicative. A looped run adds **Findings dropped by
   verification** (rejected or unanswered by the verifier, never reported).
3. Looped runs only: the profile's single-pass baseline (precision, recall,
   false positives and tokens) for reference, and a table of passes per check
   type: the cases it ran on, its passes in total, per case and at most, the
   findings it kept and those verification dropped.
4. A per-case table: stop reason, TP, FP, FN, tokens in/out and duration; for
   a looped run also the passes per check type and the findings verification
   dropped.
5. **Misses and false positives**: every false positive (with why it counted:
   `unmatched`, `duplicate` or `must_not_flag`) and every missed expected
   finding, so you can open the case and see what happened.

The JSON has the same data plus every finding (path, lines, severity,
category, title, confidence and verdict) and, for a looped run, every pass of
every check type (files, findings reported, confirmed, new and dropped,
verification, unreached areas) for scripting and diffing two runs.

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
pull request. The baseline keeps the two strategies apart
(`strategies.single`, `strategies.looped`), and `--update-baseline` only
replaces entries of the run's strategy. A baseline from before strategies
(`"version": 1` with `profiles`) reads as single-pass entries, and the next
`--update-baseline` rewrites it in the current format.

When you change a depth's pass settings, run both strategies for that profile
and compare the looped run's precision, recall and tokens with the single-pass
baseline shown beside it.

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
