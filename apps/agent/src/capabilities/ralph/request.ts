import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildRequestPrompt,
  readRequestResult,
  REQUEST_OUTPUT_SCHEMA,
  requestSystemAppend,
  type Epic,
  type Story,
} from "@omniralph/ralph";
import {
  MAX_LEASE_SECONDS,
  RalphRequestPayload,
  type JobPayload,
  type RalphRequestResult,
} from "@omniralph/shared";
import type { BranchWorktree } from "../../workspace/repoCache.js";
import { RetryableJobError, type JobContext } from "../index.js";
import { ActivityRelay } from "./activities.js";
import { RALPH_TOOL_POLICY } from "./policy.js";
import { createSessionRunner, type SessionRequest, type SessionResult } from "./session.js";
import { DEFAULT_STORY_MODEL, sessionEnv, type StoryOptions } from "./story.js";

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
  return `omniralph ralph ${payload.runId} request `;
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
 * repository's `historyRewrite`). It may commit and push the branch; PR/MR
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
  const runSession = options.runSession ?? createSessionRunner();
  const env = ctx.env();
  const plainEnv = sessionEnv(env);
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
        // Whatever an earlier session left behind is set aside first.
        const leftover = await worktree.stashWork(label("pre-run"));
        if (leftover) {
          log.info({ stash: leftover }, "stashed leftover work");
          relay.post({
            type: "thought",
            body: `The worktree had uncommitted changes from an earlier session, so I stashed them first (\`${leftover.slice(0, 10)}\`).`,
            ephemeral: false,
          });
        }
        const progressDir = await mkdtemp(path.join(tmpdir(), "omniralph-progress-"));
        const progressFile = path.join(progressDir, "progress.md");
        try {
          await writeFile(progressFile, payload.progress);
          const prompt = buildRequestPrompt({
            epic: requestEpic(payload),
            requests: payload.requests.map((r) => r.text),
            branch: payload.branch,
            baseBranch: payload.baseBranch,
            remoteUrl: payload.repository.cloneUrl,
            ...(payload.prUrl && { prUrl: payload.prUrl }),
            progressFile,
            qualityGates: payload.qualityGates,
            prTerm: payload.repository.provider === "gitlab" ? "merge request" : "pull request",
            historyRewrite: payload.historyRewrite,
            ...(payload.settings.appendInstruction && {
              appendInstruction: payload.settings.appendInstruction,
            }),
          });
          const request: SessionRequest = {
            prompt,
            cwd: worktree.path,
            policy: RALPH_TOOL_POLICY,
            systemAppend: requestSystemAppend(payload.historyRewrite),
            outputSchema: REQUEST_OUTPUT_SCHEMA,
            model: payload.settings.model ?? DEFAULT_STORY_MODEL,
            ...(payload.settings.fallbackModel && {
              fallbackModel: payload.settings.fallbackModel,
            }),
            tools: {
              allowedTools: payload.settings.allowedTools,
              disallowedTools: payload.settings.disallowedTools,
            },
            additionalDirectories: [progressDir],
            env: plainEnv,
            signal: ctx.signal,
            ...(options.idleTimeoutMs !== undefined && { idleTimeoutMs: options.idleTimeoutMs }),
            onEvent: (event) => relay.event(event),
            // Replies from the Linear thread reach the live session (see `jobMessages`).
            onInjector: (inject) => ctx.setMessageInjector?.(inject),
            // Follow-ups continue this conversation, like Cyrus resuming its Claude session.
            persistSession: true,
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

          // The agent commits what it means to keep; anything else is set aside so the next session starts clean.
          const stashSha = await stashQuietly(worktree, label("unfinished"), log);
          const read =
            session.stop === "completed" ? readRequestResult(session.structured) : undefined;
          const base = {
            sessionId: session.sessionId ?? null,
            ...(stashSha && { stashSha }),
            usage: session.usage,
            durationMs: Date.now() - started,
          };
          if (!read || "problem" in read) {
            const why = read
              ? `it ended without a valid structured result (${read.problem})`
              : sessionError(session);
            return {
              ...base,
              summary: clip(tail(session.output, 2000)),
              error: clip(why),
            };
          }
          log.info({ pullRequest: read.result.pullRequest?.action ?? null }, "request done");
          return {
            ...base,
            summary: clip(read.result.summary),
            error: null,
            ...(read.result.pullRequest && {
              pullRequest: {
                action: read.result.pullRequest.action,
                ...(read.result.pullRequest.title && {
                  title: clip(read.result.pullRequest.title, 500),
                }),
                ...(read.result.pullRequest.body && {
                  body: clip(read.result.pullRequest.body, 60_000),
                }),
              },
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
    await relay.flush();
  }
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
