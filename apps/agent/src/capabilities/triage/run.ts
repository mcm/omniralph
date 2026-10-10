import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildTriagePrompt,
  TRIAGE_OUTPUT_SCHEMA,
  TRIAGE_SYSTEM_APPEND,
  validateTriageOutput,
  type TriageAgentOutput,
} from "@omniralph/ralph";
import {
  MAX_LEASE_SECONDS,
  TriageRunPayload,
  TriageRunResult,
  type JobPayload,
} from "@omniralph/shared";
import { RetryableJobError, type JobContext } from "../index.js";
import { createSessionRunner, type SessionResult, type SessionRunner } from "../ralph/session.js";
import { DEFAULT_STORY_MODEL, sessionEnv } from "../ralph/story.js";
import { TRIAGE_TOOL_POLICY } from "./policy.js";

/** Longest summary or error returned (`TriageRunResult`). */
const MAX_TEXT = 20_000;

export interface TriageOptions {
  /** Runs the Claude session; defaults to the Agent SDK. Injected in tests. */
  runSession?: SessionRunner;
  /** The Claude model of triage sessions (default `DEFAULT_STORY_MODEL`). */
  model?: string;
  /** Retry delay for rate limits whose reset time is unknown. */
  defaultRetryAfterSeconds?: number;
  idleTimeoutMs?: number;
}

function clip(text: string, max = MAX_TEXT): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function tail(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}

/** The job's outcome from a valid session result (the agent output minus `summary`). */
function outcomeOf(output: TriageAgentOutput): TriageRunResult["outcome"] {
  const { summary: _summary, ...outcome } = output;
  return outcome;
}

/**
 * Runs `fn` in the directory a triage session reads: a fresh worktree of the
 * routed repository's default branch, or an empty directory without one (or
 * when the branch doesn't exist yet, e.g. an empty repository).
 */
async function withTriageDir<T>(
  payload: TriageRunPayload,
  job: JobPayload,
  ctx: JobContext,
  fn: (cwd: string, checkedOut: boolean) => Promise<T>,
): Promise<T> {
  const routed = payload.repository;
  if (routed) {
    const git = { env: ctx.env(), signal: ctx.signal };
    const sha = await ctx.repos.branchHead(routed.repository, routed.defaultBranch, git);
    if (sha) {
      return ctx.repos.withWorktree(routed.repository, sha, { ...git, jobId: job.id }, (wt) =>
        fn(wt.path, true),
      );
    }
    ctx.logger.warn(
      { branch: routed.defaultBranch },
      "the default branch doesn't exist; triaging without a checkout",
    );
  }
  const dir = await mkdtemp(path.join(tmpdir(), "omniralph-triage-"));
  try {
    return await fn(dir, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Why a session ended without a usable result. */
function failure(session: SessionResult): string {
  return session.stop === "idle"
    ? `The triage session was stopped: ${session.error ?? "it was idle"}`
    : `The triage session failed: ${session.error ?? "unknown error"}`;
}

/**
 * Triages one Linear issue (`triage.run`): a read-only Claude session
 * (`TRIAGE_TOOL_POLICY`) over the issue from the payload and, when a
 * repository is routed, a checkout of its default branch, ending with a
 * structured result (`TRIAGE_OUTPUT_SCHEMA`). Returns the validated outcome,
 * or an `error` result when the session failed or its result isn't valid. A
 * Claude rate limit throws `RetryableJobError`; an abort rethrows.
 */
export async function runTriage(
  job: JobPayload,
  ctx: JobContext,
  options: TriageOptions = {},
): Promise<TriageRunResult> {
  const parsed = TriageRunPayload.safeParse(job.payload);
  if (!parsed.success) throw new Error("invalid triage.run payload");
  const payload = parsed.data;
  const started = Date.now();
  const log = ctx.logger.child({
    issue: payload.issue.identifier,
    ...(payload.repository && {
      repo: `${payload.repository.repository.provider}/${payload.repository.repository.fullPath}`,
    }),
  });
  const runSession = options.runSession ?? createSessionRunner();

  const session = await withTriageDir(payload, job, ctx, (cwd, checkedOut) =>
    runSession({
      prompt: buildTriagePrompt({
        ...payload,
        // Without a checkout there is nothing to read: say there's no repository.
        repository: checkedOut ? payload.repository : null,
      }),
      cwd,
      policy: TRIAGE_TOOL_POLICY,
      systemAppend: TRIAGE_SYSTEM_APPEND,
      outputSchema: TRIAGE_OUTPUT_SCHEMA,
      model: options.model ?? DEFAULT_STORY_MODEL,
      env: sessionEnv(ctx.env()),
      signal: ctx.signal,
      ...(options.idleTimeoutMs !== undefined && { idleTimeoutMs: options.idleTimeoutMs }),
    }),
  );

  if (session.stop === "aborted" || ctx.signal.aborted) {
    throw ctx.signal.reason ?? new Error("the triage session was aborted");
  }
  if (session.stop === "rate_limited") {
    const seconds =
      session.retryAfterMs !== undefined
        ? Math.ceil(session.retryAfterMs / 1000)
        : (options.defaultRetryAfterSeconds ?? 300);
    throw new RetryableJobError(
      session.error ?? "Claude rate limit",
      Math.min(Math.max(seconds, 1), MAX_LEASE_SECONDS),
    );
  }

  const done = (fields: Pick<TriageRunResult, "summary" | "error" | "outcome">) => {
    const base = { usage: session.usage, durationMs: Date.now() - started };
    const checked = TriageRunResult.safeParse({ ...fields, ...base });
    if (checked.success) return checked.data;
    // E.g. more stories than a job result may carry.
    const error = clip(`The triage result doesn't fit the job result: ${checked.error.message}`);
    log.warn({ err: checked.error }, "triage result out of bounds");
    return TriageRunResult.parse({ summary: error, error, outcome: null, ...base });
  };

  if (session.stop !== "completed") {
    const error = clip(failure(session));
    log.warn({ stop: session.stop, error: session.error }, "triage session failed");
    return done({ summary: error, error, outcome: null });
  }
  const validated = validateTriageOutput(session.structured);
  if ("problem" in validated) {
    const error = clip(
      `The triage session ended without a valid result (${validated.problem}). Its final message was: ${tail(session.output, 1000) || "(none)"}`,
    );
    log.warn({ problem: validated.problem }, "invalid triage result");
    return done({ summary: error, error, outcome: null });
  }
  const { result } = validated;
  log.info(
    {
      outcome: result.outcome,
      size: result.size,
      stories: result.stories.length,
      subIssueUpdates: result.subIssueUpdates.length,
      openQuestions: result.openQuestions.length,
      usage: session.usage,
    },
    "triage finished",
  );
  return done({ summary: clip(result.summary), error: null, outcome: outcomeOf(result) });
}
