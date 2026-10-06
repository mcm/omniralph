/**
 * Preparation of manual stories (ported from cyralph's `engine/preparation.ts`
 * and `EpicEngine.runApprovedPreparation`/`askPreparation`): when a manual
 * story with ```cyralph-prepare commands becomes unblocked, the run asks in a
 * `select` elicitation whether to run them, bound to the commands' hash and
 * the branch's last story commit. "Run it" enqueues a `ralph.prepare` job (the
 * run's one job), which runs nothing if either changed. The story stays
 * manual: a person still moves it to Done. The run pushes nothing to ask.
 */
import {
  getJob,
  updateRun,
  type Job,
  type RalphPreparation,
  type RalphPreparationRequest,
  type RalphRun,
  type RalphStory,
  type RalphTransaction,
} from "@omniralph/db";
import {
  eligiblePreparations,
  fenced,
  PREPARATION_OPTIONS,
  preparationHash,
  preparationQuestion,
  type Story,
} from "@omniralph/ralph";
import { RalphPreparePayload, RalphPrepareResult } from "@omniralph/shared";
import { postActivity, tail } from "./notify";
import { jobFailure } from "./outcome";
import type { RalphDeps } from "./run";

const ACTIVE_JOB_STATUSES = new Set<Job["status"]>(["queued", "running"]);

export const EMPTY_PREPARATION: RalphPreparation = { request: null, handled: {} };

/** The run's preparation state (none yet: nothing asked or handled). */
export function preparationOf(run: Pick<RalphRun, "preparation">): RalphPreparation {
  return { ...EMPTY_PREPARATION, ...run.preparation };
}

const storyIdOf = (s: Story) => s.issueId ?? s.key;
const nameOf = (s: Pick<Story, "identifier" | "storyId">) => s.identifier ?? s.storyId;

/**
 * The branch's HEAD as far as the control panel knows: the newest of the
 * stories' commits (ordered by when their job finished) and the HEAD the last
 * `ralph.prepare` job reported. Null when nothing was committed yet.
 */
export async function knownBranchHead(
  deps: Pick<RalphDeps, "db">,
  rows: readonly RalphStory[],
  state: RalphPreparation,
): Promise<string | null> {
  let newest: { sha: string; at: number } | null = state.head
    ? { sha: state.head.sha, at: Date.parse(state.head.at) }
    : null;
  for (const row of rows) {
    if (!row.commitSha) continue;
    const job = row.lastJobId ? await getJob(deps.db, row.lastJobId) : null;
    const at = (job?.finishedAt ?? row.updatedAt).getTime();
    if (!newest || at > newest.at) newest = { sha: row.commitSha, at };
  }
  return newest?.sha ?? null;
}

/**
 * Asks about the next manual story whose preparation can run (in `step`, when
 * no story can run). After `rerun preparation`, that is the earliest open one
 * even if it was handled. A question whose story can't run anymore (done,
 * blocked again) is dropped; one still open isn't asked again. Returns
 * whether a question was posted (it then stands for the run's elicitation).
 */
export async function offerPreparation(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
  input: { stories: readonly Story[]; rows: readonly RalphStory[]; waiting?: string },
): Promise<boolean> {
  const before = preparationOf(run);
  const state: RalphPreparation = { ...before, handled: { ...before.handled } };
  if (state.rerun) {
    delete state.rerun;
    const again = eligiblePreparations(input.stories)[0];
    if (again) {
      delete state.handled[storyIdOf(again)];
      // Asked again from scratch, even if it is the open question.
      state.request = null;
    } else {
      await postActivity(deps.linear, run.linearAgentSessionId, {
        type: "thought",
        body: "No open manual story with preparation commands can run now, so there's nothing to ask about again.",
      });
    }
  }
  const eligible = eligiblePreparations(input.stories, new Set(Object.keys(state.handled)));
  if (state.request && !eligible.some((s) => storyIdOf(s) === state.request?.storyIssueId)) {
    state.request = null;
  }
  const next = state.request ? undefined : eligible[0];
  if (!next) {
    if (JSON.stringify(state) !== JSON.stringify(before)) {
      await updateRun(tx, run.id, { preparation: state });
    }
    return false;
  }

  const commands = next.preparation ?? [];
  const headSha = await knownBranchHead(deps, input.rows, state);
  const lead = [state.lead, input.waiting].filter(Boolean).join("\n\n") || undefined;
  delete state.lead;
  state.request = {
    storyIssueId: storyIdOf(next),
    identifier: nameOf(next),
    title: next.title,
    commandsHash: preparationHash(commands),
    headSha,
    askedAt: new Date().toISOString(),
  };
  await updateRun(tx, run.id, { preparation: state });
  await postActivity(
    deps.linear,
    run.linearAgentSessionId,
    {
      type: "elicitation",
      body: preparationQuestion({
        story: { storyId: nameOf(next), title: next.title },
        branch: run.branch,
        headSha,
        commands,
        lead,
      }),
    },
    {
      signal: "select",
      signalMetadata: { options: PREPARATION_OPTIONS.map((value) => ({ value })) },
    },
  );
  return true;
}

/**
 * The manual story whose preparation was approved ("Run it") and isn't
 * running yet, if it can still run; an approval whose story can't run anymore
 * (done, blocked again) is dropped. `run.ts` enqueues its `ralph.prepare` job.
 */
export async function approvedPreparation(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
  stories: readonly Story[],
): Promise<{ run: RalphRun; story?: Story; request?: RalphPreparationRequest }> {
  const state = preparationOf(run);
  const request = state.request;
  if (request?.answer !== "run" || request.jobId) return { run };
  const story = eligiblePreparations(stories, new Set(Object.keys(state.handled))).find(
    (s) => storyIdOf(s) === request.storyIssueId,
  );
  if (story) return { run, story, request };
  const updated =
    (await updateRun(tx, run.id, { preparation: { ...state, request: null } })) ?? run;
  await postActivity(deps.linear, run.linearAgentSessionId, {
    type: "thought",
    body: `**${request.identifier}** can't be prepared now (it's done or blocked again), so I ran nothing.`,
  });
  return { run: updated };
}

/** The commands a `ralph.prepare` job ran, with their exit codes and output tails. */
function ranCommands(result: RalphPrepareResult): string {
  return result.commands
    .map((c) => {
      const exit = c.exitCode === null ? "didn't finish" : `exit ${c.exitCode}`;
      const output = c.output.trim() ? `\n\n${fenced(tail(c.output.trim(), 3000))}` : "";
      return `\`${c.command}\` (${exit})${output}`;
    })
    .join("\n\n");
}

/**
 * Applies the outcome of the run's `ralph.prepare` job (in phase 1 of
 * `advanceRun`, under the row lock) and posts it as an activity. Success: the
 * story counts as prepared and isn't asked about again, even when the branch
 * moves later. A failure, a stale approval or a failed job: nothing is retried
 * on its own; the question is asked again (by `offerPreparation`), led by what
 * happened. Returns whether the job is still queued or running.
 */
export async function applyPreparationJob(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
  now = new Date(),
): Promise<{ busy: boolean }> {
  const state = preparationOf(run);
  const request = state.request;
  if (!request?.jobId) return { busy: false };
  const job = await getJob(deps.db, request.jobId);
  if (job && ACTIVE_JOB_STATUSES.has(job.status)) return { busy: true };

  const story = `**${request.identifier}**`;
  const parsed = job?.status === "completed" ? RalphPrepareResult.safeParse(job.result) : null;
  const payload = job ? RalphPreparePayload.safeParse(job.payload) : null;
  const next: RalphPreparation = { ...state, request: null, handled: { ...state.handled } };
  let body: string;
  if (!parsed?.success) {
    const why = parsed ? "the agent sent an invalid result" : jobFailure(job);
    next.lead = `The preparation of ${story} didn't run: ${why}. Nothing is retried on its own.`;
    body = next.lead;
  } else {
    const result = parsed.data;
    next.head = { sha: result.headSha, at: now.toISOString() };
    const at = `\`${result.headSha.slice(0, 10)}\``;
    if (result.status === "completed") {
      next.handled[request.storyIssueId] = {
        how: "prepared",
        at: now.toISOString(),
        headSha: result.headSha,
      };
      body = [
        `Ran the preparation of ${story} at ${at}:`,
        ranCommands(result),
        `The rest of ${request.identifier} is up to a person, who marks it done.`,
      ].join("\n\n");
    } else if (result.status === "failed") {
      const failed = result.commands.at(-1);
      const total = payload?.success ? payload.data.commands.length : result.commands.length;
      const skipped = total - result.commands.length;
      next.lead =
        `\`${failed?.command ?? "A command"}\` failed with ${failed?.exitCode === null || !failed ? "no exit code" : `exit ${failed.exitCode}`}, so I stopped there` +
        `${skipped > 0 ? ` and didn't run the ${skipped} command${skipped === 1 ? "" : "s"} after it` : ""}. Nothing is retried on its own.`;
      body = [`The preparation of ${story} failed:`, ranCommands(result)].join("\n\n");
    } else {
      const changed = [
        payload?.success && payload.data.approvedHeadSha !== result.headSha
          ? `\`${run.branch}\` (now at ${at})`
          : "",
        payload?.success && preparationHash(payload.data.commands) !== request.commandsHash
          ? "its commands"
          : "",
      ].filter(Boolean);
      next.lead = `${changed.length > 0 ? changed.join(" and ") : "The branch or the commands"} changed since I asked about the preparation of ${story}, so I ran nothing. Here it is again as it is now.`;
      body = next.lead;
    }
  }
  await updateRun(tx, run.id, { preparation: next });
  await postActivity(deps.linear, run.linearAgentSessionId, { type: "thought", body });
  return { busy: false };
}
