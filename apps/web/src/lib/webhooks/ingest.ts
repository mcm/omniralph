import "server-only";
import {
  claimWebhookDelivery,
  deleteScmConnection,
  findLaneByBranch,
  findLaneByPullRequest,
  findRepositoriesByExternalId,
  findScmConnectionsByExternalId,
  releaseWebhookDelivery,
  setWebhookDeliveryJob,
  updatePullRequestState,
  type Database,
  type Repository,
  type ScmConnection,
  type ScmProvider,
  type WebhookDeliveryRef,
  type WebhookEventRun,
  getRun,
} from "@omniralph/db";
import type { ChangeRequest, ScmAdapter } from "@omniralph/scm";
import type { JobDispatcher } from "@/lib/dispatch";
import { bumpOrganizationHeartbeat } from "@/lib/agents/heartbeat-cache";
import { connectionBotHandle, isOwnComment, parseBotCommand } from "@/lib/mentions/commands";
import { runBotCommand, type BotCommandOutcome } from "@/lib/mentions/handle";
import { getLinearGatewayOrDisconnected, lazyLinearGateway } from "@/lib/linear/client";
import type { LinearGateway } from "@/lib/linear/gateway";
import { respondToCiEvent } from "@/lib/ralph/ci";
import type { ChatSource } from "@/lib/ralph/conversation";
import { cleanupClosedPullRequest } from "@/lib/ralph/cleanup";
import { storeDefaultBranch } from "@/lib/repositories/default-branch";
import { enqueueReview } from "@/lib/review/enqueue";
import { scmAdapterFor } from "@/lib/scm/adapters";
import {
  githubInstallationId,
  parseGitHubCiEvent,
  parseGitHubCommentEvent,
  parseGitHubEvent,
  parseGitHubInstallationDeleted,
  parseGitHubClosedEvent,
  parseGitHubPullRequestStateEvent,
  parseGitLabCiEvent,
  parseGitLabCommentEvent,
  parseGitLabEvent,
  parseGitLabClosedEvent,
  parseGitLabPullRequestStateEvent,
  webhookDefaultBranch,
  webhookRepositoryId,
  type ChangeRequestEvent,
  type CiEvent,
  type CommentEvent,
  type ClosedEvent,
  type PullRequestStateEvent,
} from "./events";
import { DeliveryLog, type DeliveryResult } from "./delivery-log";
import type { WebhookIgnoreReason } from "./reasons";

/** Code-host lookups a handler may make stay well inside the 3s webhook budget. */
export const WEBHOOK_LOOKUP_TIMEOUT_MS = 2_000;

interface ProviderSpec {
  eventHeader: string;
  deliveryHeader: string;
  parse(eventName: string | null, body: unknown): ChangeRequestEvent | null;
  parseComment(eventName: string | null, body: unknown): CommentEvent | null;
  parseCi(eventName: string | null, body: unknown): CiEvent | null;
  parseClosed(eventName: string | null, body: unknown): ClosedEvent | null;
  parseState(eventName: string | null, body: unknown): PullRequestStateEvent | null;
}

const PROVIDERS: Record<ScmProvider, ProviderSpec> = {
  github: {
    eventHeader: "x-github-event",
    deliveryHeader: "x-github-delivery",
    parse: parseGitHubEvent,
    parseComment: parseGitHubCommentEvent,
    parseCi: parseGitHubCiEvent,
    parseClosed: parseGitHubClosedEvent,
    parseState: parseGitHubPullRequestStateEvent,
  },
  gitlab: {
    eventHeader: "x-gitlab-event",
    deliveryHeader: "x-gitlab-event-uuid",
    parse: parseGitLabEvent,
    parseComment: parseGitLabCommentEvent,
    parseCi: parseGitLabCiEvent,
    parseClosed: parseGitLabClosedEvent,
    parseState: parseGitLabPullRequestStateEvent,
  },
};

export interface WebhookDeps {
  db: Database;
  dispatcher: JobDispatcher;
  adapterFor?: (db: Database, connection: ScmConnection) => ScmAdapter;
  /**
   * Runs `@bot` command work after the response is sent (the route passes
   * Next.js `after`), so code-host calls don't count against the webhook
   * timeout. Defaults to running it before responding.
   */
  defer?: (task: () => Promise<void>) => void | Promise<void>;
  /** The handle where the connection has no bot username (GitHub): default `BOT_HANDLE`. */
  handle?: string;
  /** The Linear workspace, for `@bot` requests to ralph runs; default: the connected one. */
  linear?: () => Promise<LinearGateway>;
  /** Where ralph runs from chat post (default: the deployment's chat bot). */
  chat?: ChatSource;
}

type Outcome =
  | { status: "enqueued"; reviewId: string; jobId: string }
  | { status: "duplicate"; jobId?: string }
  | { status: "accepted"; command: string }
  | { status: "accepted"; event: "ci_failure" | "merged" | "closed" | "pull_request_state" }
  | { status: "removed"; connections: number }
  | { status: "ignored"; reason: WebhookIgnoreReason };

const reply = (outcome: Outcome) => Response.json(outcome);
const ignored = (reason: WebhookIgnoreReason) => reply({ status: "ignored", reason });

/** A verified delivery's response, and what it did for the delivery log. */
interface Handled {
  response: Response;
  result: DeliveryResult;
}

const handled = (outcome: Outcome, result: DeliveryResult): Handled => ({
  response: reply(outcome),
  result,
});
const skipped = (reason: WebhookIgnoreReason, run?: WebhookEventRun | null): Handled =>
  handled({ status: "ignored", reason }, { outcome: "ignored", reasonCode: reason, run });
const internalError = (error: unknown): Handled => ({
  response: Response.json({ error: "internal_error" }, { status: 500 }),
  result: { outcome: "failed", error },
});

/** A ralph run as the log links it. */
const ralphRun = (run: { id: string; mode: "epic" | "request" }): WebhookEventRun => ({
  id: run.id,
  kind: run.mode,
});

/**
 * The delivery's event as the log names it: the event header and the body's action
 * (`pull_request.synchronize`, `Merge Request Hook.update`).
 */
export function webhookEventName(
  provider: ScmProvider,
  eventName: string | null,
  body: unknown,
): string {
  const payload =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const attributes = payload.object_attributes;
  const action =
    provider === "github"
      ? payload.action
      : typeof attributes === "object" && attributes !== null
        ? (attributes as Record<string, unknown>).action
        : undefined;
  const event = eventName?.trim() || "unknown";
  return typeof action === "string" && action ? `${event}.${action}` : event;
}

/**
 * A GitHub App uninstall: verifies the delivery (signed with the app's webhook secret) and
 * removes the installation's connection with its repositories, so the installation is no
 * longer tied to an organization.
 */
async function handleInstallationDeleted(
  deps: WebhookDeps,
  req: Request,
  rawBody: string,
  installationId: string,
): Promise<Response> {
  const { db, adapterFor = scmAdapterFor } = deps;
  const connections = await findScmConnectionsByExternalId(db, "github", installationId);
  if (connections.length === 0) return ignored("unknown_installation");
  if (!(await adapterFor(db, connections[0]!).verifyWebhook(req.headers, rawBody))) {
    return Response.json({ error: "invalid_signature" }, { status: 401 });
  }
  for (const connection of connections) {
    await deleteScmConnection(db, connection.organizationId, connection.id);
    // Its repositories' pins went with it.
    await bumpOrganizationHeartbeat(connection.organizationId);
  }
  return reply({ status: "removed", connections: connections.length });
}

/**
 * Handles a GitHub/GitLab webhook delivery: finds the connected repository,
 * verifies the signature with its connection's adapter (401 if invalid), which
 * resolves the organization (the connection's), hands it to
 * `processVerifiedDelivery` (which applies the repo's triggers and enqueues a
 * review) and records what it did in the delivery log (`webhook_events`). It only writes and
 * publishes (no review work), so it answers well within the code host's
 * timeout. Unknown, disabled or disconnected repos and irrelevant events get
 * 200 without side effects; a delivery ID that was already acted on is a no-op.
 * A GitHub App uninstall removes the installation's connection. Draft and
 * review state changes of a ralph PR/MR are recorded on its lane.
 */
export async function handleWebhook(
  provider: ScmProvider,
  req: Request,
  deps: WebhookDeps,
): Promise<Response> {
  const { db, adapterFor = scmAdapterFor } = deps;
  const spec = PROVIDERS[provider];
  const rawBody = await req.text();
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  if (provider === "github") {
    const installationId = parseGitHubInstallationDeleted(req.headers.get(spec.eventHeader), body);
    if (installationId) return handleInstallationDeleted(deps, req, rawBody, installationId);
  }

  const externalId = webhookRepositoryId(provider, body);
  const candidates = externalId ? await findRepositoriesByExternalId(db, provider, externalId) : [];
  if (candidates.length === 0) return ignored("unknown_repository");

  // GitHub: the delivery's installation first. GitLab: the connection whose secret matches.
  const installationId = provider === "github" ? githubInstallationId(body) : null;
  candidates.sort(
    (a, b) =>
      Number(b.connection.externalId === installationId) -
      Number(a.connection.externalId === installationId),
  );
  let match: { repository: Repository; connection: ScmConnection; adapter: ScmAdapter } | null =
    null;
  for (const { repository, connection } of candidates) {
    const adapter = adapterFor(db, connection);
    if (await adapter.verifyWebhook(req.headers, rawBody)) {
      match = { repository, connection, adapter };
      break;
    }
  }
  if (!match) return Response.json({ error: "invalid_signature" }, { status: 401 });
  const { repository, connection } = match;
  // The delivery belongs to the organization of the connection that verified it: the
  // reviews and jobs it creates hang off `repository`, which is in that organization.
  if (repository.organizationId !== connection.organizationId) {
    return ignored("unknown_repository");
  }
  // Every verified delivery names the repository's default branch: keep the stored one current.
  const defaultBranch = webhookDefaultBranch(provider, body);
  if (defaultBranch) await storeDefaultBranch(db, repository, defaultBranch);

  const eventName = req.headers.get(spec.eventHeader);
  const deliveryId = req.headers.get(spec.deliveryHeader)?.trim();
  const log = new DeliveryLog(db, {
    organizationId: connection.organizationId,
    provider,
    source: { scmConnectionId: connection.id },
    repositoryId: repository.id,
    deliveryId: deliveryId || null,
    event: webhookEventName(provider, eventName, body),
    rawBody,
  });
  const { response, result } = await processVerifiedDelivery({
    ...deps,
    ...match,
    provider,
    eventName,
    deliveryId: deliveryId || null,
    body,
    log,
  });
  await log.record(result);
  return response;
}

/**
 * The event header a delivery was sent with, from the name the log stored
 * (`webhookEventName`'s inverse): `pull_request.synchronize` → `pull_request`.
 */
export function webhookHeaderEvent(
  provider: ScmProvider,
  event: string,
  body: unknown,
): string | null {
  // `.synchronize`, or nothing when the body has no action.
  const action = webhookEventName(provider, "x", body).slice(1);
  const name = action && event.endsWith(action) ? event.slice(0, -action.length) : event;
  return name === "unknown" || name === "" ? null : name;
}

/**
 * Replays a stored delivery of a connected repository through `processVerifiedDelivery`,
 * as a live delivery runs, with today's settings. Its signature was verified on receipt,
 * and it skips the delivery-ID claim (the original claimed it). Deferred work runs
 * before it returns. Records a new delivery log row with `replayOfId` and `replayedBy`;
 * returns its ID (null when writing it failed).
 */
export async function replayWebhookDelivery(
  deps: WebhookDeps,
  input: {
    provider: ScmProvider;
    repository: Repository;
    connection: ScmConnection;
    event: string;
    deliveryId: string | null;
    body: unknown;
    replayOfId: string;
    replayedBy: string;
  },
): Promise<string | null> {
  const { db, adapterFor = scmAdapterFor } = deps;
  const { provider, repository, connection, body } = input;
  const log = new DeliveryLog(db, {
    organizationId: connection.organizationId,
    provider,
    source: { scmConnectionId: connection.id },
    repositoryId: repository.id,
    deliveryId: input.deliveryId,
    event: input.event,
    rawBody: JSON.stringify(body),
    replayOfId: input.replayOfId,
    replayedBy: input.replayedBy,
  });
  const { result } = await processVerifiedDelivery({
    ...deps,
    defer: undefined,
    repository,
    connection,
    adapter: adapterFor(db, connection),
    provider,
    eventName: webhookHeaderEvent(provider, input.event, body),
    deliveryId: null,
    body,
    log,
  });
  await log.record(result);
  return log.id();
}

/**
 * A verified delivery of a connected repository: applies the repo's triggers and
 * switches, enqueues a review, records a PR/MR's state, hands a CI failure or a
 * closed PR/MR to its ralph run, or runs a `@bot` command. Returns the response and
 * what it did; deferred work settles its outcome on `log`. Without a `deliveryId`
 * (none sent, or a replay) nothing is claimed, so it never counts as a duplicate.
 */
export async function processVerifiedDelivery(
  input: WebhookDeps & {
    repository: Repository;
    connection: ScmConnection;
    adapter: ScmAdapter;
    provider: ScmProvider;
    eventName: string | null;
    deliveryId: string | null;
    body: unknown;
    log: DeliveryLog;
  },
): Promise<Handled> {
  const { db, dispatcher, repository, adapter, provider, eventName, deliveryId, body } = input;
  const spec = PROVIDERS[provider];
  const delivery = deliveryId ? { provider, deliveryId } : null;
  const ci = spec.parseCi(eventName, body);
  if (ci) return handleCi({ ...input, delivery, ci });
  const closed = spec.parseClosed(eventName, body);
  if (closed) return handleClosed({ ...input, delivery, closed });
  const reviewsOff = async () => !!repository.disconnectedAt || !repository.reviewsEnabled;
  const event = spec.parse(eventName, body);
  const prState = spec.parseState(eventName, body);
  if (prState) {
    // Opening, reopening and ready-for-review also trigger reviews, which go on as before.
    let failure: unknown;
    const stateOutcome = await applyPullRequestState(input, prState).catch((error: unknown) => {
      console.error(
        `${provider} webhook ${deliveryId ?? "(no delivery ID)"} failed to record the state of ${repository.fullPath}#${prState.number}`,
        error,
      );
      failure = error;
      return null;
    });
    if (!event) return stateOutcome ?? internalError(failure);
  }
  if (!event) {
    const comment = spec.parseComment(eventName, body);
    if (!comment) return skipped("unsupported_event");
    if (await reviewsOff()) return skipped("repository_disabled");
    return handleComment({ ...input, delivery, comment });
  }
  if (await reviewsOff()) return skipped("repository_disabled");
  const { triggers } = repository;
  if (event.kind === "open" && !triggers.onOpen) return skipped("trigger_disabled");
  if (event.kind === "push" && !triggers.onPush) return skipped("trigger_disabled");
  if (event.draft && !triggers.drafts) return skipped("draft");

  if (delivery && !(await claimWebhookDelivery(db, { ...delivery, repositoryId: repository.id }))) {
    return handled({ status: "duplicate" }, { outcome: "duplicate" });
  }

  try {
    const details = await withDetails(adapter, repository, event);
    const result = await enqueueReview(db, dispatcher, {
      repositoryId: repository.id,
      prNumber: event.number,
      baseSha: details.baseSha,
      headSha: event.headSha,
      title: details.title,
      description: details.description,
      author: details.author,
      trigger: "webhook",
    });
    if (result.status === "repository_unavailable") return skipped("repository_disabled");
    if (result.status === "no_review_tasks") return skipped("no_review_tasks");
    if (delivery) await setWebhookDeliveryJob(db, delivery, result.jobId);
    const run: WebhookEventRun = { id: result.reviewRunId, kind: "review" };
    if (result.status === "duplicate") {
      return handled({ status: "duplicate", jobId: result.jobId }, { outcome: "duplicate", run });
    }
    return handled(
      { status: "enqueued", reviewId: result.reviewId, jobId: result.jobId },
      { outcome: "started_run", run },
    );
  } catch (error) {
    // Let the code host's redelivery try again.
    if (delivery) await releaseWebhookDelivery(db, delivery).catch(() => undefined);
    console.error(`${provider} webhook ${deliveryId ?? "(no delivery ID)"} failed`, error);
    return internalError(error);
  }
}

/**
 * A comment that mentions the bot: the bot's own (and other bots') comments
 * and comments without a mention are ignored; a delivery ID that was already
 * acted on is a no-op. The command runs via `defer` and replies on the code
 * host; its failures are logged (the delivery stays claimed, so a redelivery
 * doesn't run a command twice).
 */
async function handleComment(
  input: WebhookDeps & {
    repository: Repository;
    connection: ScmConnection;
    adapter: ScmAdapter;
    provider: ScmProvider;
    delivery: WebhookDeliveryRef | null;
    comment: CommentEvent;
    log: DeliveryLog;
  },
): Promise<Handled> {
  const { db, repository, delivery, comment, log } = input;
  const handle = connectionBotHandle(input.connection, input.handle);
  if (isOwnComment(comment.author, handle)) return skipped("own_comment");
  const command = parseBotCommand(comment.body, handle);
  if (!command) return skipped("no_mention");
  if (delivery && !(await claimWebhookDelivery(db, { ...delivery, repositoryId: repository.id }))) {
    return handled({ status: "duplicate" }, { outcome: "duplicate" });
  }
  const task = async () => {
    let result: DeliveryResult;
    try {
      result = await commandResult(db, await runBotCommand({ ...input, handle, command }));
    } catch (error) {
      console.error(
        `${input.provider} @${handle} ${command.kind} on ${repository.fullPath}#${comment.number} failed`,
        error,
      );
      result = { outcome: "failed", error };
    }
    await log.settle(result);
  };
  const defer = input.defer ?? ((run: () => Promise<void>) => run());
  await defer(task);
  return handled({ status: "accepted", command: command.kind }, { outcome: "updated_run" });
}

/** What a `@bot` command did, for the delivery log. */
async function commandResult(db: Database, outcome: BotCommandOutcome): Promise<DeliveryResult> {
  switch (outcome.status) {
    case "review_enqueued":
      return { outcome: "started_run", run: { id: outcome.reviewRunId, kind: "review" } };
    case "review_duplicate":
      return { outcome: "duplicate", run: { id: outcome.reviewRunId, kind: "review" } };
    case "ralph_request":
    case "ralph_unavailable": {
      const run = await getRun(db, outcome.runId);
      const linked = run && ralphRun(run);
      return outcome.status === "ralph_request"
        ? { outcome: "updated_run", run: linked }
        : { outcome: "ignored", reasonCode: "run_finished", run: linked };
    }
    case "refused":
      return { outcome: "ignored", reasonCode: "command_refused" };
    case "review_unavailable":
      return { outcome: "ignored", reasonCode: "repository_disabled" };
    case "query_disabled":
      return { outcome: "ignored", reasonCode: "query_disabled" };
    case "not_in_finding_thread":
      return { outcome: "ignored", reasonCode: "not_in_finding_thread" };
    case "not_ralph":
      return { outcome: "ignored", reasonCode: "not_ralph" };
    case "help":
      return { outcome: "ignored", reasonCode: "help" };
    case "dismissed":
    case "dismiss_conflict":
    case "reply_enqueued":
      return { outcome: "updated_run" };
  }
}

/**
 * A finished CI run (GitHub `workflow_run`, GitLab Pipeline Hook): a failure
 * on a ralph PR/MR's lane is handed to the ralph run (`respondToCiEvent`, via
 * `defer`, since it reads the CI status and job logs from the code host).
 * Passing runs, repositories without ralph and PRs/MRs that aren't ralph
 * lanes are ignored; a delivery ID that was already acted on is a no-op.
 */
async function handleCi(
  input: WebhookDeps & {
    repository: Repository;
    connection: ScmConnection;
    provider: ScmProvider;
    delivery: WebhookDeliveryRef | null;
    ci: CiEvent;
    log: DeliveryLog;
  },
): Promise<Handled> {
  const { db, repository, delivery, ci, log } = input;
  if (!ci.failed) return skipped("ci_not_failed");
  if (repository.disconnectedAt || !repository.codingEnabled) {
    return skipped("ralph_disabled");
  }
  const lanes = await Promise.all([
    ...ci.prNumbers.map((n) => findLaneByPullRequest(db, repository.id, n)),
    ci.prNumbers.length === 0 && ci.branch
      ? findLaneByBranch(db, repository.id, ci.branch)
      : Promise.resolve(null),
  ]);
  const found = lanes.find(Boolean);
  if (!found) return skipped("not_ralph");
  const run = ralphRun(found.run);
  if (delivery && !(await claimWebhookDelivery(db, { ...delivery, repositoryId: repository.id }))) {
    return handled({ status: "duplicate" }, { outcome: "duplicate", run });
  }
  const task = async () => {
    try {
      const organizationId = repository.organizationId;
      const linear = lazyLinearGateway(
        input.linear ?? (() => getLinearGatewayOrDisconnected({ db, organizationId })),
      );
      await respondToCiEvent(
        {
          db,
          organizationId,
          linear,
          dispatcher: input.dispatcher,
          adapterFor: input.adapterFor ?? scmAdapterFor,
          chat: input.chat,
        },
        repository.id,
        ci,
      );
    } catch (error) {
      console.error(
        `${input.provider} CI failure on ${repository.fullPath} (${ci.headSha}) failed`,
        error,
      );
      await log.settle({ outcome: "failed", error });
    }
  };
  const defer = input.defer ?? ((run: () => Promise<void>) => run());
  await defer(task);
  return handled({ status: "accepted", event: "ci_failure" }, { outcome: "updated_run", run });
}

/**
 * A closed PR/MR, merged or not: when it's a ralph lane's, it's recorded and
 * the cleanup of its worktree starts (`cleanupClosedPullRequest`, via
 * `defer`, since it confirms the state with the code host): merged, the
 * local branch goes too; closed unmerged, it's kept. Other PRs/MRs are
 * ignored; a delivery ID that was already acted on is a no-op.
 */
async function handleClosed(
  input: WebhookDeps & {
    repository: Repository;
    connection: ScmConnection;
    provider: ScmProvider;
    delivery: WebhookDeliveryRef | null;
    closed: ClosedEvent;
    log: DeliveryLog;
  },
): Promise<Handled> {
  const { db, repository, delivery, closed, log } = input;
  const found = await findLaneByPullRequest(db, repository.id, closed.number);
  if (!found) return skipped("not_ralph");
  const run = ralphRun(found.run);
  if (delivery && !(await claimWebhookDelivery(db, { ...delivery, repositoryId: repository.id }))) {
    return handled({ status: "duplicate" }, { outcome: "duplicate", run });
  }
  const task = async () => {
    try {
      const organizationId = repository.organizationId;
      const linear = lazyLinearGateway(
        input.linear ?? (() => getLinearGatewayOrDisconnected({ db, organizationId })),
      );
      await cleanupClosedPullRequest(
        {
          db,
          organizationId,
          linear,
          dispatcher: input.dispatcher,
          adapterFor: input.adapterFor ?? scmAdapterFor,
          chat: input.chat,
        },
        found.lane,
      );
    } catch (error) {
      console.error(
        `${input.provider} ${closed.merged ? "merge" : "closing"} of ${repository.fullPath}#${closed.number} failed to clean up`,
        error,
      );
      await log.settle({ outcome: "failed", error });
    }
  };
  const defer = input.defer ?? ((run: () => Promise<void>) => run());
  await defer(task);
  return handled(
    { status: "accepted", event: closed.merged ? "merged" : "closed" },
    { outcome: "updated_run", run },
  );
}

/**
 * A PR/MR's draft or review state: recorded on its ralph lanes (others are
 * ignored as `not_ralph`), whatever the repository's switches, so the Inbox
 * knows which of Om's PRs/MRs wait on a person. Reviews and approvals by the
 * connection's bot (or any bot) are ignored. Redeliveries just apply the
 * same state again.
 */
async function applyPullRequestState(
  input: WebhookDeps & { repository: Repository; connection: ScmConnection },
  event: PullRequestStateEvent,
): Promise<Handled> {
  const { db, repository } = input;
  if (
    event.reviewer &&
    isOwnComment(event.reviewer, connectionBotHandle(input.connection, input.handle))
  ) {
    return skipped("own_review");
  }
  const found = await findLaneByPullRequest(db, repository.id, event.number);
  if (!found) return skipped("not_ralph");
  await updatePullRequestState(db, repository.id, event.number, {
    draft: event.draft,
    reviewState: event.reviewState,
    occurredAt: event.occurredAt,
  });
  return handled(
    { status: "accepted", event: "pull_request_state" },
    { outcome: "updated_run", run: ralphRun(found.run) },
  );
}

/**
 * Fills in what the event lacks (GitLab: the target-branch commit to diff
 * against and the MR author) from the code host, within the timeout. Any
 * target-branch commit works as the base: reviews diff `base...head`.
 */
async function withDetails(
  adapter: ScmAdapter,
  repository: Repository,
  event: ChangeRequestEvent,
): Promise<ChangeRequestEvent & { baseSha: string }> {
  if (event.baseSha && event.author !== null) return { ...event, baseSha: event.baseSha };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Timed out looking up the change request")),
      WEBHOOK_LOOKUP_TIMEOUT_MS,
    );
  });
  try {
    const cr: ChangeRequest = await Promise.race([
      adapter.getChangeRequest(
        { fullPath: repository.fullPath, externalId: repository.externalId },
        event.number,
      ),
      timeout,
    ]);
    return {
      ...event,
      baseSha: event.baseSha ?? cr.startSha ?? cr.baseSha,
      author: event.author ?? cr.author,
    };
  } finally {
    clearTimeout(timer);
  }
}
