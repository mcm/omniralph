# ADR 0013: Runs loop: work, verify, feed the findings back

- **Status:** Accepted (TOOL-952, TOOL-954).
- **Date:** 2026-11-02

## Context

Only coding runs looped: a story retried with feedback (`maxAttemptsPerStory`), and a story that
reported a metric got rounds with stall detection (`recordRound` in
`apps/web/src/lib/ralph/outcome.ts`). Reviews and triage were single sessions whose output was
applied as it came back. A session that grades its own work rarely finds its own mistakes, and
Ralph Loop 2.0 (TOOL-922) wants every run that can be checked to be checked before its output
counts.

TOOL-953 made every playbook role declare `loop: "looped" | "none"`, gave looped roles that don't
code a `loop` block (`maxIterations`, `stallRounds`), and added the `verifier` and `audit` helper
roles. Something has to run those loops.

## Decision

**Looped query and review runs are driven by one loop driver in the control panel
(`apps/web/src/lib/runs/loop.ts`). Each iteration is a worker session, then a verifier session
that hasn't seen the worker's reasoning. The worker never decides it is done; the verifier does.
Its findings become the next iteration's input until it reports convergence, the run used its
`maxIterations`, or the metric it reports stalls for `stallRounds` iterations. Every iteration is
stored in `run_iterations` and published live.**

### The driver

- `startLoop(db, run, playbook)` reads `playbookLoopSettings(playbook)`. A single-session role
  (and a coding role, which loops by its story attempts and rounds) gets null: its run is one
  session, as before. A looped role gets its first iteration, with the limits copied onto it so a
  playbook edit doesn't change a running loop, and its worker job.
- `advanceLoop(db, job, finish)` advances the loop a finished job belongs to, in a transaction
  that locks the iteration: a completed worker starts its verifier; a verifier's verdict ends the
  loop or starts the next iteration with the verifier's summary and findings as the worker's
  `feedback`; a failed or canceled worker or verifier, or a verifier answer that isn't a verdict,
  fails the iteration and ends the loop (`outcome: "failed"`). Each step only moves an iteration
  from the status it expects, so a replayed result changes nothing.
- `loopOutcome(iterations, settings)` decides, in order: `converged`, `max-iterations`, `stalled`.
  The metric history is folded with the coding rounds' `addRoundMetric` and checked with their
  `isStalled` (`apps/web/src/lib/ralph/rounds.ts`): one implementation of stall detection.

### What a verifier answers

A verifier is a query run whose structured output is a `LoopVerdict`: `converged` (boolean), a
`summary`, the `findings` the next iteration should address, and optionally a `metric` (`name`,
`value`, `direction`, `target`, as a story reports). Verifier playbooks use the `run-result` sink.
Nothing in the loop relies on a provider-specific feature: a verifier is a playbook with its own
model, so it can run on a different model or provider than the worker.

### Kinds of run plug in

What a worker and a verifier are depends on the kind of run (`run_iterations.run_kind`: `review`,
`triage`). Each kind registers a `LoopAdapter` (`registerLoopAdapter`): `startWorker` (the
iteration and its feedback), `startVerifier` (the iteration and the worker's job) and `finish`
(the loop's outcome and every iteration). Reviews, documentation checks and triage register
theirs as they move onto the loop (TOOL-952's epics 4 to 6).

### The job lifecycle hands loop jobs to the driver

`lib/sinks` wraps every sink whose runs may be loop jobs (`sinkMayLoop`: the sinks of looped
query and review roles, and the verifier's `run-result`): when a finished job is an iteration's
worker, its own sink applies it first and then the driver advances the loop; when it is an
iteration's verifier, the driver reads its verdict instead of the sink. Jobs outside any loop are
untouched.

### Iterations are records

`run_iterations` has one row per iteration: the run (`run_kind`, `run_id`), its `number`,
`status` (`working`, `verifying`, `done`, `failed`), the worker's `feedback`, the worker and
verifier jobs, the verifier's `verdict`, `summary`, `findings` and `metric`, an `error`, the
copied limits, its timestamps, and on the last iteration the loop's `outcome`. Every write records
a live `run` change for the run, and the run detail (`GET /api/ui/runs/{id}`) lists them as
`iterations`.

## Consequences

- Reviews and triage don't change until they register an adapter: this ADR adds the driver they
  use, not their move onto it.
- Coding keeps its own loop (attempts, rounds); the task verifier and the epic audit (TOOL-955,
  TOOL-956) are invoked from the ralph run, not through this driver.
- A loop job's sink isn't told it is part of a loop: a worker's output is applied as it comes back,
  and the adapter's `finish` decides what the loop's end means for the run.
- Every finished `run-result`, `review` and `triage` job costs one indexed lookup in
  `run_iterations`.
