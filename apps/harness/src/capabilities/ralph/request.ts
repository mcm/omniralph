import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildRequestPrompt,
  isWaitingRequest,
  readRequestResult,
  REQUEST_OUTPUT_SCHEMA,
  requestSystemAppend,
  type Epic,
  type RequestAgentOutput,
  type ShipStash,
  type Story,
} from "@omniralph/ralph";
import {
  MAX_LEASE_SECONDS,
  ralphStashPrefix,
  RalphRequestPayload,
  type JobPayload,
  type RalphRequestResult,
} from "@omniralph/shared";
import type { BranchWorktree } from "../../workspace/repoCache.js";
import { RetryableJobError, type JobContext } from "../index.js";
import { ActivityRelay } from "../../tools/activities.js";
import { PermissionRelay } from "../../tools/permissions.js";
import { controlPanelFetcher, jobAttachments } from "../../tools/attachments.js";
import { RALPH_TOOL_POLICY } from "./policy.js";
import { sessionGitAccess } from "./git-access.js";
import { createSessionRunner, type SessionRequest, type SessionResult } from "./session.js";
import { DEFAULT_STORY_MODEL, type StoryOptions } from "./story.js";

const MAX_TEXT = 20_000;

function tail(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}

function clip(text: string, max = MAX_TEXT): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Label prefix of a run's request stash entries (never offered to its stories). */
export function requestStashPrefix(payload: Pick<RalphRequestPayload, "runId">): string {
  return `${ralphStashPrefix(payload.runId)}request `;
}

/** The epic `buildRequestPrompt` expects, from the job's payload. */
export function requestEpic(payload: RalphRequestPayload): Epic {
  const stories: Story[] = payload.stories.map((s) => ({
    key: s.identifier,
    storyId: s.identifier,
    identifier: s.identifier,
    title: s.title,
    description: "",
    acceptanceCriteria: [],
    priority: 0,
    dependsOn: s.dependsOn,
    status: s.status,
    ...(s.manual && { manual: true }),
    ...(s.repository && { repo: { id: "", name: s.repository, routedBy: "" } }),
  }));
  return {
    kind: payload.epic.kind,
    issueId: "",
    identifier: payload.epic.identifier,
    title: payload.epic.title,
    description: payload.epic.prd,
    ...(payload.epic.url && { url: payload.epic.url }),
    branchName: payload.branch,
    qualityGates: payload.qualityGates,
    stories,
  };
}

/** Why a session failed, in cyralph's words. */
function sessionError(session: SessionResult): string {
  return session.stop === "idle"
    ? `the session was stopped: ${session.error ?? "it was idle"}`
    : `the session failed: ${session.error ?? "unknown error"}`;
}

/**
 * Does what a lane's pending requests ask (ported from cyralph's
 * `EpicEngine.runRequests`): one Claude session in the lane's branch
 * worktree, after setting aside what an earlier session left (`pre-run`),
 * with ralph's tool policy and the request system prompt (which follows the
 * repository's `historyRewrite`). It may commit and push the branch (git
 * authenticates through the brokered helper, see `sessionGitAccess`); PR/MR
 * changes come back as `pullRequest` for the control panel to make. The
 * lane's previous request conversation is resumed when the payload names it
 * (retried fresh when the resume fails without a session). What the session
 * leaves uncommitted is stashed and reported. Replies from the Linear thread
 * reach the live session. A Claude rate limit throws `RetryableJobError`; a
 * canceled job stashes its work and rejects.
 */
export async function runRequest(
  job: JobPayload,
  ctx: JobContext,
  options: StoryOptions = {},
): Promise<RalphRequestResult> {
  const parsed = RalphRequestPayload.safeParse(job.payload);
  if (!parsed.success) throw new Error("invalid ralph.request payload");
  const payload = parsed.data;
  const started = Date.now();
  const log = ctx.logger.child({
    repo: `${payload.repository.provider}/${payload.repository.fullPath}`,
    branch: payload.branch,
    requests: payload.requests.length,
  });
  const relay = new ActivityRelay({
    server: ctx.server,
    jobId: job.id,
    jobToken: ctx.jobToken,
    logger: log,
    ...(options.fetch && { fetch: options.fetch }),
  });
  const permissions = new PermissionRelay({
    server: ctx.server,
    jobId: job.id,
    jobToken: ctx.jobToken,
    logger: log,
    ...(options.fetch && { fetch: options.fetch }),
    ...(options.permissionTimeoutMs !== undefined && {
      timeoutMs: options.permissionTimeoutMs,
    }),
    ...(options.permissionPollIntervalMs !== undefined && {
      pollIntervalMs: options.permissionPollIntervalMs,
    }),
  });
  const runSession = options.runSession ?? createSessionRunner();
  const env = ctx.env();
  // The session fetches and pushes the branch itself, through the brokered helper.
  const git = await sessionGitAccess(ctx);
  const label = (reason: string) => `${requestStashPrefix(payload)}${reason}`;

  try {
    return await ctx.repos.withBranchWorktree(
      payload.repository,
      {
        branch: payload.branch,
        baseBranch: payload.baseBranch,
        ...(payload.settings.setupCommand && { setupCommand: payload.settings.setupCommand }),
        env,
        signal: ctx.signal,
      },
      async (worktree) => {
        // Whatever an earlier session left behind is set aside first (`/ship` ships it instead).
        const leftover = payload.ship ? null : await worktree.stashWork(label("pre-run"));
        if (leftover) {
          log.info({ stash: leftover }, "stashed leftover work");
          relay.post({
            type: "thought",
            body: `The worktree had uncommitted changes from an earlier session, so I stashed them first (\`${leftover.slice(0, 10)}\`).`,
            ephemeral: false,
          });
        }
        // Files attached in Linear, downloaded through the control panel (which holds the token).
        const attachments = await jobAttachments({
          attachments: payload.attachments,
          epicIdentifier: payload.epic.identifier,
          workspaceRoot: ctx.workspaceRoot,
          fetcher: controlPanelFetcher({
            server: ctx.server,
            jobId: job.id,
            jobToken: ctx.jobToken,
            signal: ctx.signal,
            ...(options.fetch && { fetch: options.fetch }),
          }),
          logger: log,
          report: (body) => relay.post({ type: "thought", body, ephemeral: false }),
        });
        const progressDir = await mkdtemp(path.join(tmpdir(), "omniralph-progress-"));
        const progressFile = path.join(progressDir, "progress.md");
        try {
          await writeFile(progressFile, payload.progress);
          const shipStashes = payload.ship ? await requestStashes(worktree, payload) : [];
          const prompt = buildRequestPrompt({
            epic: requestEpic(payload),
            requests: payload.requests.map((r) => r.text),
            source: payload.source,
            branch: payload.branch,
            baseBranch: payload.baseBranch,
            remoteUrl: payload.repository.cloneUrl,
            ...(payload.prUrl && { prUrl: payload.prUrl }),
            progressFile,
            qualityGates: payload.qualityGates,
            prTerm: payload.repository.provider === "gitlab" ? "merge request" : "pull request",
            historyRewrite: payload.historyRewrite,
            ...(attachments.prompt && { attachments: attachments.prompt }),
            ...(payload.settings.appendInstruction && {
              appendInstruction: payload.settings.appendInstruction,
            }),
            ...(payload.ship && { ship: { stashes: shipStashes } }),
          });
          const request: SessionRequest = {
            prompt,
            cwd: worktree.path,
            policy: RALPH_TOOL_POLICY,
            systemAppend: requestSystemAppend(payload.historyRewrite, payload.source, {
              ship: payload.ship,
            }),
            outputSchema: REQUEST_OUTPUT_SCHEMA,
            isWaiting: isWaitingRequest,
            model: payload.settings.model ?? DEFAULT_STORY_MODEL,
            ...(payload.settings.fallbackModel && {
              fallbackModel: payload.settings.fallbackModel,
            }),
            tools: {
              allowedTools: payload.settings.allowedTools,
              disallowedTools: payload.settings.disallowedTools,
            },
            additionalDirectories: [
              progressDir,
              ...(attachments.files.length > 0 ? [attachments.dir] : []),
            ],
            env: git.env,
            signal: ctx.signal,
            ...(options.idleTimeoutMs !== undefined && { idleTimeoutMs: options.idleTimeoutMs }),
            onEvent: (event) => relay.event(event),
            // Replies from the Linear thread reach the live session (see `jobMessages`).
            onInjector: (inject) => ctx.setMessageInjector?.(inject),
            // Follow-ups continue this conversation, like Cyrus resuming its Claude session.
            persistSession: true,
            // The repository's Claude Code settings may `ask` about calls (e.g. `git commit`).
            askPermission: (call, signal) => permissions.ask(call, signal),
          };
          const resume = payload.resumeSessionId ?? undefined;
          let session = await runSession({ ...request, ...(resume && { resume }) });
          if (resume && session.stop === "error" && !session.sessionId && !ctx.signal.aborted) {
            log.warn({ resume }, "could not resume the request session; starting fresh");
            session = await runSession(request);
          }

          if (session.stop === "aborted" || ctx.signal.aborted) {
            await stashQuietly(worktree, label("stopped"), log);
            throw ctx.signal.reason ?? new Error("the request session was aborted");
          }
          if (session.stop === "rate_limited") {
            await stashQuietly(worktree, label("rate-limited"), log);
            const seconds =
              session.retryAfterMs !== undefined
                ? Math.ceil(session.retryAfterMs / 1000)
                : (options.defaultRetryAfterSeconds ?? 300);
            throw new RetryableJobError(
              session.error ?? "Claude rate limit",
              Math.min(Math.max(seconds, 1), MAX_LEASE_SECONDS),
            );
          }

          const read =
            session.stop === "completed" ? readRequestResult(session.structured) : undefined;
          const stoppedWaiting =
            session.stop === "completed" && isWaitingRequest(session.structured);
          const valid = read && !("problem" in read) && !stoppedWaiting ? read.result : undefined;
          // `/ship`: the job commits and pushes what the session prepared.
          const shipped =
            payload.ship && valid ? await ship(worktree, payload, valid, log) : undefined;
          // The agent commits what it means to keep; anything else is set aside so the next session starts clean.
          const stashSha = await stashQuietly(worktree, label("unfinished"), log);
          const base = {
            sessionId: session.sessionId ?? null,
            ...(stashSha && { stashSha }),
            ...(shipped?.commitSha && { commitSha: shipped.commitSha }),
            ...(shipped && { pushed: shipped.pushed }),
            usage: session.usage,
            durationMs: Date.now() - started,
          };
          if (shipped?.error) {
            return { ...base, summary: clip(valid?.summary ?? ""), error: clip(shipped.error) };
          }
          if (!read || "problem" in read || stoppedWaiting) {
            const why = stoppedWaiting
              ? `the session was stopped while it waited for background work: ${session.error ?? "it gave up waiting"}`
              : read && "problem" in read
                ? `it ended without a valid structured result (${read.problem})`
                : sessionError(session);
            return {
              ...base,
              summary: clip(tail(session.output, 2000)),
              error: clip(why),
            };
          }
          log.info(
            {
              pullRequest: read.result.pullRequest?.action ?? null,
              findings: read.result.findings?.length ?? 0,
            },
            "request done",
          );
          const pullRequest = read.result.pullRequest ?? shipped?.pullRequest;
          return {
            ...base,
            summary: clip(read.result.summary),
            error: null,
            ...(pullRequest && {
              pullRequest: {
                action: pullRequest.action,
                ...(pullRequest.title && { title: clip(pullRequest.title, 500) }),
                ...(pullRequest.body && { body: clip(pullRequest.body, 60_000) }),
              },
            }),
            ...(read.result.findings && {
              findings: read.result.findings.map((f) => ({
                findingId: f.id,
                outcome: f.outcome,
                comment: f.comment,
              })),
            }),
          };
        } catch (error) {
          if (ctx.signal.aborted) await stashQuietly(worktree, label("stopped"), log);
          throw error;
        } finally {
          await rm(progressDir, { recursive: true, force: true });
        }
      },
    );
  } finally {
    await git.close();
    await relay.flush();
  }
}

/** The run's request stash entries in the stash list, newest first (offered to a `/ship` session). */
async function requestStashes(
  worktree: BranchWorktree,
  payload: RalphRequestPayload,
): Promise<ShipStash[]> {
  const prefix = requestStashPrefix(payload);
  const entries = await worktree.listStashes();
  return entries
    .filter((e) => e.label.startsWith(prefix))
    .slice(0, 20)
    .map((e) => ({ sha: e.sha, label: e.label, date: e.date }));
}

/** Identity for commits on hosts without a git `user.email`. */
const FALLBACK_IDENTITY = ["-c", "user.name=Omniralph", "-c", "user.email=omniralph@localhost"];

/** What `ship` did: the commit it made, whether it pushed, the PR/MR to open, or why it failed. */
interface Shipped {
  commitSha?: string;
  pushed: boolean;
  pullRequest?: NonNullable<RequestAgentOutput["pullRequest"]>;
  error?: string;
}

/**
 * `/ship` after the session prepared the worktree: commits everything with
 * the session's message (outside Claude Code, so the repository's `ask`
 * rules don't apply), pushes the branch when `origin` doesn't have its head,
 * and asks for the PR/MR to be opened when the lane has none and the branch
 * has commits the base doesn't. A failed commit or push undoes the commit
 * (its changes are then stashed with the rest) and reports why.
 */
async function ship(
  worktree: BranchWorktree,
  payload: RalphRequestPayload,
  result: RequestAgentOutput,
  log: JobContext["logger"],
): Promise<Shipped> {
  // Set once the commit exists and until it's pushed: an unexpected failure undoes it.
  const state: { unpushedCommit?: string } = {};
  try {
    return await shipSteps(worktree, payload, result, log, state);
  } catch (error) {
    log.warn({ err: error }, "shipping failed");
    if (state.unpushedCommit) {
      await worktree.git(["reset", "--quiet", "HEAD~1"]).catch(() => {});
    }
    return {
      pushed: false,
      error: `shipping failed${state.unpushedCommit ? " (the commit was undone)" : ""}:\n\n\`\`\`\n${tail(errorText(error), 4000)}\n\`\`\``,
    };
  }
}

async function shipSteps(
  worktree: BranchWorktree,
  payload: RalphRequestPayload,
  result: RequestAgentOutput,
  log: JobContext["logger"],
  state: { unpushedCommit?: string },
): Promise<Shipped> {
  const git = (args: readonly string[]) => worktree.git(args);
  const tryGit = (args: readonly string[]) =>
    git(args).then(
      (out) => out.trim(),
      () => null,
    );
  const remoteHead = () =>
    tryGit(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${payload.branch}`]);

  let commitSha: string | undefined;
  await git(["add", "-A"]);
  const staged = (await git(["diff", "--cached", "--name-only"])).trim();
  if (staged) {
    const message = result.commit?.message;
    if (!message) {
      await git(["reset", "--quiet"]);
      return {
        pushed: false,
        error:
          "the session left uncommitted changes but no commit message, so nothing was committed or pushed",
      };
    }
    const identity = (await tryGit(["config", "--get", "user.email"])) ? [] : FALLBACK_IDENTITY;
    try {
      await git([...identity, "commit", "--quiet", "-m", message]);
    } catch (error) {
      await git(["reset", "--quiet"]).catch(() => {});
      return {
        pushed: false,
        error: `committing the work failed (e.g. a git hook rejected it):\n\n\`\`\`\n${tail(errorText(error), 4000)}\n\`\`\``,
      };
    }
    state.unpushedCommit = "HEAD";
    commitSha = (await git(["rev-parse", "HEAD"])).trim();
    state.unpushedCommit = commitSha;
    log.info({ commit: commitSha }, "committed the shipped work");
  }

  const head = (await git(["rev-parse", "HEAD"])).trim();
  let pushed = false;
  if ((await remoteHead()) !== head) {
    try {
      await git(["push", "--quiet", "-u", "origin", payload.branch]);
      delete state.unpushedCommit;
      pushed = true;
      log.info({ head }, "pushed the shipped branch");
    } catch (error) {
      // Undo the commit, so its changes are stashed with the rest instead of lost in a local commit.
      if (commitSha) await git(["reset", "--quiet", "HEAD~1"]).catch(() => {});
      delete state.unpushedCommit;
      return {
        pushed: false,
        error: `${commitSha ? "the work was committed, but pushing it failed, so the commit was undone" : "pushing the branch failed"}:\n\n\`\`\`\n${tail(errorText(error), 4000)}\n\`\`\``,
      };
    }
  }

  // No PR/MR yet: open one when the branch has something to review.
  let pullRequest: Shipped["pullRequest"];
  if (!payload.prUrl && !result.pullRequest) {
    const ahead = await tryGit(["rev-list", "--count", `origin/${payload.baseBranch}..HEAD`]);
    if (ahead !== null && Number(ahead) > 0) {
      const [subject, ...rest] = (result.commit?.message ?? "").split("\n");
      const body = rest.join("\n").trim();
      pullRequest = {
        action: "open",
        ...(subject?.trim() && { title: subject.trim() }),
        ...(body && { body }),
      };
    }
  }
  return { ...(commitSha && { commitSha }), pushed, ...(pullRequest && { pullRequest }) };
}

/** An error's message (a git failure's includes its output). */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Stashes the worktree's changes (even after a cancel); the stash SHA, or null. A failure is logged. */
async function stashQuietly(
  worktree: BranchWorktree,
  label: string,
  log: JobContext["logger"],
): Promise<string | null> {
  try {
    const sha = await worktree.stashWork(label, { signal: null });
    if (sha) log.info({ stash: sha, label }, "stashed the request's work");
    return sha;
  } catch (error) {
    log.warn({ err: error, label }, "stashing the request's work failed");
    return null;
  }
}
