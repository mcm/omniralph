/**
 * The PRs/MRs of a ralph run (ported from cyralph's `syncPullRequest`,
 * `describePullRequest`, `publishLane` and `finish`): one per lane (each
 * repository the run works in). The control panel opens and updates them
 * through the SCM adapter; agents never hold code-host API tokens. When every
 * story is done, each lane with commits gets a `ralph.describe-pr` job, one at
 * a time, that writes its title and body; its outcome (applied by
 * `advanceRun` under the run's row lock) opens the lane's PR/MR as a draft or
 * updates the open one and marks it ready. Once every lane is through, the run
 * completes, or waits on a reply when one of them failed. With
 * `openPullRequestEarly`, a lane's draft with a templated body is opened as
 * soon as its first story is pushed.
 */
import {
  getJob,
  getRepository,
  getRepositoryWithConnection,
  listLanes,
  updateLane,
  updateRun,
  type Job,
  type RalphLane,
  type RalphRun,
  type RalphStory,
  type RalphTransaction,
  type Repository,
  type ScmConnection,
  isLinearRun,
  linearSessionOf,
} from "@omniralph/db";
import type { Epic } from "@omniralph/ralph";
import type { RepoRef, ScmAdapter } from "@omniralph/scm";
import {
  epicCompletedTarget,
  parseRalphSettings,
  RalphDescribePrPayload,
  RalphDescribePrResult,
} from "@omniralph/shared";
import { repositoryWebUrl } from "@/lib/repositories/web-url";
import { errorMessage, postActivity, quietly, tail } from "./notify";
import { jobFailure } from "./outcome";
import { sanitizePullRequestText, type PullRequestText } from "./pull-request";
import type { RalphDeps } from "./run";

const ACTIVE_JOB_STATUSES = new Set<Job["status"]>(["queued", "running"]);

type Provider = Repository["provider"];

/** "pull request" (GitHub) or "merge request" (GitLab). */
export function changeRequestTerm(provider: Provider): string {
  return provider === "gitlab" ? "merge request" : "pull request";
}

/** The label of a PR/MR link in the agent session. */
export function changeRequestLabel(provider: Provider, number: number): string {
  return provider === "gitlab" ? `Merge request !${number}` : `Pull request #${number}`;
}

/** The Linear epic a PR/MR links back to. */
export interface LinearLink {
  identifier: string;
  title: string;
  url?: string | null;
}

/**
 * Appended to every PR/MR body after sanitizing (so the Linear link, which
 * isn't on the code host, stays a link). Readers of a public repository may
 * not be able to open it, so it's only a footnote.
 */
export function pullRequestFooter(epic: LinearLink): string {
  const linear = epic.url ? `[${epic.identifier}](${epic.url})` : epic.identifier;
  return ["---", `Linear: ${linear} · _Opened by Omniralph._`].join("\n");
}

/** The title and body of an early (draft) PR/MR, before the describe job rewrites them. */
export function templatedPullRequest(
  epic: LinearLink,
  stories: readonly Pick<RalphStory, "identifier" | "title" | "status">[],
  provider: Provider,
): PullRequestText {
  const done = (s: (typeof stories)[number]) => s.status === "completed" || s.status === "canceled";
  return {
    title: epic.title,
    body: [
      `Implements **${epic.title}**, story by story. This ${changeRequestTerm(provider)} stays a draft ` +
        "until every story is done; its description is rewritten then.",
      "",
      "**Stories**",
      "",
      ...stories.map((s) => `- [${done(s) ? "x" : " "}] ${s.identifier}: ${s.title}`),
    ].join("\n"),
  };
}

export interface LaneRepository {
  adapter: ScmAdapter;
  repo: RepoRef;
  repository: Repository;
  connection: ScmConnection;
  /** The lane (its branch and PR/MR). */
  lane: RalphLane;
}

export async function laneRepository(deps: RalphDeps, lane: RalphLane): Promise<LaneRepository> {
  const found = await getRepositoryWithConnection(deps.db, lane.repositoryId);
  if (!found || found.repository.disconnectedAt) {
    throw new Error("the repository is no longer connected");
  }
  return {
    lane,
    adapter: deps.adapterFor(deps.db, found.connection),
    repo: { fullPath: found.repository.fullPath, externalId: found.repository.externalId },
    repository: found.repository,
    connection: found.connection,
  };
}

/** Agent- or Linear-written text, sanitized for the code host, with the Linear footer. */
export async function postableText(
  target: LaneRepository,
  text: PullRequestText,
  epic: LinearLink,
): Promise<PullRequestText> {
  const { adapter, repo, repository, connection } = target;
  const webUrl = repositoryWebUrl(repository.provider, connection.baseUrl, repository.fullPath);
  const clean = await sanitizePullRequestText(text, {
    allowedHosts: [new URL(webUrl).hostname],
    isRepositoryUser: (username) => adapter.hasWriteAccess(repo, username),
  });
  return { title: clean.title, body: `${clean.body.trim()}\n\n${pullRequestFooter(epic)}` };
}

export interface PublishedPullRequest {
  number: number;
  url: string;
  /** Opened now, rather than an open one updated. */
  created: boolean;
}

/**
 * Opens a lane's PR/MR as a draft or, when one is open for its branch,
 * updates its title and body (never a second one); then marks it ready.
 */
export async function publishPullRequest(
  deps: RalphDeps,
  lane: RalphLane,
  text: PullRequestText,
  epic: LinearLink,
): Promise<PublishedPullRequest> {
  const target = await laneRepository(deps, lane);
  const { adapter, repo } = target;
  const { title, body } = await postableText(target, text, epic);
  let pr: PublishedPullRequest;
  const open = await adapter.findOpenChangeRequest(repo, lane.branch);
  if (open) {
    await adapter.updateChangeRequest(repo, open.number, { title, body });
    pr = { number: open.number, url: open.url, created: false };
  } else {
    const opened = await adapter.createChangeRequest(repo, {
      sourceBranch: lane.branch,
      targetBranch: lane.baseBranch,
      title,
      body,
      draft: true,
    });
    // Opened by someone else meanwhile: it gets this text all the same.
    if (!opened.created) await adapter.updateChangeRequest(repo, opened.number, { title, body });
    pr = opened;
  }
  await adapter.markChangeRequestReady(repo, pr.number);
  return pr;
}

/** The stories worked in a lane (those without a lane belong to the main one). */
export function laneRows<T extends Pick<RalphStory, "laneId">>(
  rows: readonly T[],
  lane: Pick<RalphLane, "id">,
  main: Pick<RalphLane, "id"> | null,
): T[] {
  return rows.filter((r) => (r.laneId ?? main?.id) === lane.id);
}

/**
 * The lanes a finish publishes (cyralph's `publishLane`), the main lane first:
 * those a story committed to, or with a PR/MR already. A lane with no commits
 * (every story of the run went elsewhere) gets no PR/MR.
 */
export function lanesToPublish(
  lanes: readonly RalphLane[],
  rows: readonly Pick<RalphStory, "laneId" | "commitSha">[],
  run: Pick<RalphRun, "repositoryId">,
): RalphLane[] {
  const main = lanes.find((l) => l.repositoryId === run.repositoryId) ?? null;
  return [...lanes]
    .sort((a, b) => Number(b === main) - Number(a === main))
    .filter((l) => l.prNumber !== null || laneRows(rows, l, main).some((r) => r.commitSha));
}

/**
 * The label of a lane's PR/MR link in the agent session: with the repository
 * when the run works in more than one.
 */
export async function sessionLinkLabel(
  tx: RalphTransaction,
  run: Pick<RalphRun, "id">,
  repository: Pick<Repository, "provider" | "fullPath">,
  number: number,
): Promise<string> {
  const label = changeRequestLabel(repository.provider, number);
  return (await listLanes(tx, run.id)).length > 1 ? `${label} (${repository.fullPath})` : label;
}

/**
 * `openPullRequestEarly` (per lane, with its repository's setting): once a
 * story of a lane is pushed, opens a draft PR/MR with a templated body (or
 * adopts the one open for the branch, as it is). Lanes without the setting,
 * with a PR/MR already or without a pushed story, and runs with every story
 * done (the describe jobs open them then) are left alone. A failure is
 * reported as a thought: the next story's outcome tries again.
 */
export async function openEarlyPullRequest(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
  input: { epic: Epic; rows: readonly RalphStory[] },
): Promise<RalphRun> {
  const lanes = await listLanes(tx, run.id);
  const main = lanes.find((l) => l.repositoryId === run.repositoryId) ?? null;
  for (const lane of lanes) {
    const rows = laneRows(input.rows, lane, main);
    if (lane.prNumber !== null || !rows.some((r) => r.status === "completed" && r.commitSha)) {
      continue;
    }
    await openEarlyLanePullRequest(deps, tx, run, { ...input, rows, lane, main: lane === main });
  }
  return run;
}

async function openEarlyLanePullRequest(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
  input: { epic: Epic; rows: readonly RalphStory[]; lane: RalphLane; main: boolean },
): Promise<void> {
  const { lane } = input;
  const found = await getRepositoryWithConnection(deps.db, lane.repositoryId);
  if (!found || !parseRalphSettings(found.repository.ralphSettings).openPullRequestEarly) return;
  const provider = found.repository.provider;
  const term = changeRequestTerm(provider);
  const where = input.main ? "" : ` in \`${found.repository.fullPath}\``;
  const epic = { identifier: input.epic.identifier, title: input.epic.title, url: input.epic.url };
  let pr: PublishedPullRequest;
  try {
    const target = await laneRepository(deps, lane);
    const open = await target.adapter.findOpenChangeRequest(target.repo, lane.branch);
    if (open) pr = { number: open.number, url: open.url, created: false };
    else {
      const text = await postableText(
        target,
        templatedPullRequest(epic, input.rows, provider),
        epic,
      );
      pr = await target.adapter.createChangeRequest(target.repo, {
        sourceBranch: lane.branch,
        targetBranch: lane.baseBranch,
        ...text,
        draft: true,
      });
    }
  } catch (error) {
    await postActivity(deps.linear, linearSessionOf(run), {
      type: "thought",
      body: `I couldn't open a draft ${term}${where} yet (I'll try again after the next story): ${tail(errorMessage(error), 1500)}`,
    });
    return;
  }
  await updateLane(tx, lane.id, { prNumber: pr.number, prUrl: pr.url });
  const label = await sessionLinkLabel(tx, run, found.repository, pr.number);
  const sessionId = linearSessionOf(run);
  if (sessionId !== null) {
    await quietly(`Adding the ${term} to session ${sessionId}`, () =>
      deps.linear.addSessionExternalUrl(sessionId, label, pr.url),
    );
  }
  await postActivity(deps.linear, linearSessionOf(run), {
    type: "thought",
    body: `${pr.created ? "Opened a draft" : "Found the open"} ${term} for \`${lane.branch}\`${where}: ${pr.url}`,
  });
}

/**
 * Every story of the epic is complete: the epic moves to the repository's
 * `epicCompletedState` (cyralph's `epicCompletedStateName`/`Type`), a state of
 * that name or else the first state of that type. Runs after the PR/MR step,
 * whether or not it worked; a single issue (or a chat run) is left alone. A failure is logged,
 * never fails the run.
 */
export async function moveCompletedEpic(
  deps: Pick<RalphDeps, "db" | "linear">,
  run: Pick<
    RalphRun,
    | "kind"
    | "origin"
    | "linearIssueId"
    | "linearIdentifier"
    | "linearAgentSessionId"
    | "repositoryId"
  >,
): Promise<void> {
  if (run.kind === "single" || !isLinearRun(run)) return;
  await quietly(`Moving epic ${run.linearIssueId} to its completed state`, async () => {
    const repository = run.repositoryId ? await getRepository(deps.db, run.repositoryId) : null;
    const target = epicCompletedTarget(
      repository && parseRalphSettings(repository.ralphSettings).epicCompletedState,
    );
    if (target) await deps.linear.setIssueState(run.linearIssueId, target);
  });
}

/**
 * Applies the outcome of the run's `ralph.describe-pr` job, once it has
 * finished (inside the run's row lock): opens or updates its lane's PR/MR
 * with the agent's title and body, marks it ready, stores it on the lane and
 * adds it to the agent session. A failed job or PR/MR call is recorded on the
 * lane as a problem. Either way `advanceRun`'s next step publishes the next
 * lane or finishes the run (`finishPublishing`). Returns whether the job is
 * still queued or running.
 */
export async function applyPullRequestJob(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
): Promise<{ busy: boolean }> {
  if (!run.prJobId) return { busy: false };
  const job = await getJob(deps.db, run.prJobId);
  if (job && ACTIVE_JOB_STATUSES.has(job.status)) return { busy: true };

  const payload = job ? RalphDescribePrPayload.safeParse(job.payload) : null;
  const lanes = await listLanes(tx, run.id);
  const lane =
    lanes.find((l) => l.publish?.status === "describing" && l.publish.jobId === run.prJobId) ??
    (payload?.success ? lanes.find((l) => l.repositoryId === payload.data.repositoryId) : null) ??
    lanes.find((l) => l.repositoryId === run.repositoryId);
  await updateRun(tx, run.id, { prJobId: null });
  if (!lane) return { busy: false };

  const provider = payload?.success
    ? payload.data.repository.provider
    : ((await getRepository(deps.db, lane.repositoryId))?.provider ?? "github");
  const term = changeRequestTerm(provider);
  const failed = (reason: string) =>
    updateLane(tx, lane.id, {
      publish: { status: "failed", problem: `I couldn't open the ${term}: ${tail(reason, 3000)}` },
    });
  const parsed = job?.status === "completed" ? RalphDescribePrResult.safeParse(job.result) : null;
  if (!parsed?.success || !payload?.success) {
    const why = parsed ? "the agent sent an invalid result" : jobFailure(job);
    await failed(`writing its description failed: ${why}.`);
    return { busy: false };
  }

  const epic: LinearLink = {
    identifier: payload.data.epic.identifier,
    title: payload.data.epic.title,
    url: payload.data.epic.url,
  };
  let pr: PublishedPullRequest;
  try {
    pr = await publishPullRequest(deps, lane, parsed.data, epic);
  } catch (error) {
    await failed(`${errorMessage(error)}.`);
    return { busy: false };
  }
  await updateLane(tx, lane.id, {
    prNumber: pr.number,
    prUrl: pr.url,
    publish: { status: "published", created: pr.created },
  });
  const label = await sessionLinkLabel(
    tx,
    run,
    { provider, fullPath: payload.data.repository.fullPath },
    pr.number,
  );
  const sessionId = linearSessionOf(run);
  if (sessionId !== null) {
    await quietly(`Adding the ${term} to session ${sessionId}`, () =>
      deps.linear.addSessionExternalUrl(sessionId, label, pr.url),
    );
  }
  return { busy: false };
}

/** A published lane, for the final response and the problem elicitation. */
export interface PublishedLane {
  lane: RalphLane;
  repository: Pick<Repository, "provider" | "fullPath">;
}

/** "pull request", "merge request", or "pull/merge request" for lanes on both code hosts. */
function termOf(lanes: readonly PublishedLane[]): string {
  const terms = new Set(lanes.map((l) => changeRequestTerm(l.repository.provider)));
  return terms.size === 1 ? [...terms][0]! : "pull/merge request";
}

/** A lane's PR/MR as a Markdown link. */
function laneLink({ lane, repository }: PublishedLane): string {
  return `[${changeRequestLabel(repository.provider, lane.prNumber ?? 0)}](${lane.prUrl ?? ""})`;
}

/**
 * Every lane to publish is through (cyralph's `finish`): with problems, they
 * are collected (prefixed "In \`<repo>\`:" when there's more than one lane)
 * into one elicitation saying what didn't happen, and the run waits until a
 * reply retries the lanes that failed. Otherwise the run completes with a final
 * response listing every lane's PR/MR (labelled by repository when there is
 * more than one) and every story. The epic moves to its completed state either
 * way.
 */
export async function finishPublishing(
  deps: RalphDeps,
  tx: RalphTransaction,
  run: RalphRun,
  input: { epic: LinearLink; rows: readonly RalphStory[]; lanes: readonly PublishedLane[] },
): Promise<RalphRun> {
  const { lanes } = input;
  const many = lanes.length > 1;
  const failed = lanes.filter((l) => l.lane.publish?.status === "failed");
  const published = lanes.filter((l) => l.lane.publish?.status === "published" && l.lane.prUrl);
  // What requests did since the last response leads it (cyralph's `requestOutput`).
  const requestOutput = run.requestOutput?.trim() || null;
  if (failed.length > 0) {
    const problems = failed.map(({ lane, repository }) => {
      const problem = lane.publish?.status === "failed" ? lane.publish.problem : "";
      return many ? `In \`${repository.fullPath}\`: ${problem}` : problem;
    });
    const error = many
      ? [
          `Every story is done, but the last step didn't happen everywhere.`,
          ...problems,
          ...(published.length > 0
            ? [
                `Ready for review: ${published.map((l) => `${laneLink(l)} in \`${l.repository.fullPath}\``).join(", ")}.`,
              ]
            : []),
        ].join("\n\n")
      : `Every story is done, but ${problems[0]}`;
    const waiting =
      (await updateRun(tx, run.id, {
        status: "waiting",
        waitingOn: { blockers: [], manual: [] },
        prJobId: null,
        requestOutput: null,
        error,
      })) ?? run;
    // A reply retries the lanes that failed; the published ones stay published.
    for (const { lane } of failed) await updateLane(tx, lane.id, { publish: null });
    const term = termOf(failed);
    await postActivity(deps.linear, linearSessionOf(run), {
      type: "elicitation",
      body: [
        requestOutput,
        `${error}\n\nReply with guidance (for example \`retry\`) and I'll try the ${term} step again, or say \`stop\`.`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    });
    await moveCompletedEpic(deps, run);
    return waiting;
  }

  const completed =
    (await updateRun(tx, run.id, {
      status: "completed",
      prJobId: null,
      waitingOn: null,
      requestOutput: null,
      error: null,
    })) ?? run;
  await postActivity(deps.linear, linearSessionOf(run), {
    type: "response",
    body: requestOutput
      ? withPullRequestLinks(requestOutput, published)
      : finalResponse(completed, input.epic, input.rows, published),
  });
  await moveCompletedEpic(deps, run);
  return completed;
}

/** The final response: every lane's PR/MR and every story with its commit. */
function finalResponse(
  run: RalphRun,
  epic: LinearLink,
  stories: readonly RalphStory[],
  lanes: readonly PublishedLane[],
): string {
  const what =
    run.kind === "single"
      ? `**${epic.identifier}**`
      : `all ${stories.length} ${stories.length === 1 ? "story" : "stories"} of **${epic.identifier}**`;
  const branch = lanes[0]?.lane.branch ?? "";
  const done = (l: PublishedLane) =>
    l.lane.publish?.status === "published" && l.lane.publish.created ? "Opened" : "Updated";
  const head =
    lanes.length === 1
      ? [
          `Finished ${what} on \`${branch}\`. ${done(lanes[0]!)} ${laneLink(lanes[0]!)}, ready for review.`,
        ]
      : [
          `Finished ${what} on \`${branch}\`. Ready for review:`,
          "",
          ...lanes.map((l) => `- \`${l.repository.fullPath}\`: ${done(l)} ${laneLink(l)}`),
        ];
  const repositoryOf = new Map(lanes.map((l) => [l.lane.id, l.repository.fullPath]));
  const main = lanes[0]?.lane.id;
  const lines = stories.map((s) => {
    const mark = s.status === "completed" ? "✅" : s.status === "canceled" ? "🚫" : "•";
    const elsewhere =
      lanes.length > 1 && s.laneId && s.laneId !== main && repositoryOf.has(s.laneId)
        ? ` (in \`${repositoryOf.get(s.laneId)}\`)`
        : "";
    return `- ${mark} **${s.identifier}**: ${s.title}${elsewhere}${s.commitSha ? ` (\`${s.commitSha.slice(0, 10)}\`)` : ""}`;
  });
  return [...head, "", ...lines].join("\n");
}

/**
 * `text` with the PR/MR links of `lanes` it doesn't mention yet, one per line
 * (named by repository when there are several), as cyralph's
 * `withPullRequestLinks`.
 */
export function withPullRequestLinks(text: string, lanes: readonly PublishedLane[]): string {
  const linked = lanes.filter((l) => l.lane.prUrl && l.lane.prNumber !== null);
  const links = linked
    .filter((l) => !text.includes(l.lane.prUrl!))
    .map(
      (l) =>
        `${changeRequestLabel(l.repository.provider, l.lane.prNumber!)}${linked.length > 1 ? ` (${l.repository.fullPath})` : ""}: ${l.lane.prUrl}`,
    );
  return links.length > 0 ? `${text}\n\n${links.join("\n")}` : text;
}
