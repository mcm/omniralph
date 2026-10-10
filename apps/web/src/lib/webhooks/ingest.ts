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
  type Database,
  type Repository,
  type ScmConnection,
  type ScmProvider,
  type WebhookDeliveryRef,
} from "@omniralph/db";
import type { ChangeRequest, ScmAdapter } from "@omniralph/scm";
import type { JobDispatcher } from "@/lib/dispatch";
import { connectionBotHandle, isOwnComment, parseBotCommand } from "@/lib/mentions/commands";
import { runBotCommand } from "@/lib/mentions/handle";
import { getLinearGatewayOrDisconnected, lazyLinearGateway } from "@/lib/linear/client";
import type { LinearGateway } from "@/lib/linear/gateway";
import { respondToCiEvent } from "@/lib/ralph/ci";
import type { ChatSource } from "@/lib/ralph/conversation";
import { cleanupMergedPullRequest } from "@/lib/ralph/cleanup";
import { enqueueReview } from "@/lib/review/enqueue";
import { scmAdapterFor } from "@/lib/scm/adapters";
import {
  githubInstallationId,
  parseGitHubCiEvent,
  parseGitHubCommentEvent,
  parseGitHubEvent,
  parseGitHubInstallationDeleted,
  parseGitHubMergeEvent,
  parseGitLabCiEvent,
  parseGitLabCommentEvent,
  parseGitLabEvent,
  parseGitLabMergeEvent,
  webhookRepositoryId,
  type ChangeRequestEvent,
  type CiEvent,
  type CommentEvent,
  type MergeEvent,
} from "./events";

/** Code-host lookups a handler may make stay well inside the 3s webhook budget. */
export const WEBHOOK_LOOKUP_TIMEOUT_MS = 2_000;

interface ProviderSpec {
  eventHeader: string;
  deliveryHeader: string;
  parse(eventName: string | null, body: unknown): ChangeRequestEvent | null;
  parseComment(eventName: string | null, body: unknown): CommentEvent | null;
  parseCi(eventName: string | null, body: unknown): CiEvent | null;
  parseMerge(eventName: string | null, body: unknown): MergeEvent | null;
}

const PROVIDERS: Record<ScmProvider, ProviderSpec> = {
  github: {
    eventHeader: "x-github-event",
    deliveryHeader: "x-github-delivery",
    parse: parseGitHubEvent,
    parseComment: parseGitHubCommentEvent,
    parseCi: parseGitHubCiEvent,
    parseMerge: parseGitHubMergeEvent,
  },
  gitlab: {
    eventHeader: "x-gitlab-event",
    deliveryHeader: "x-gitlab-event-uuid",
    parse: parseGitLabEvent,
    parseComment: parseGitLabCommentEvent,
    parseCi: parseGitLabCiEvent,
    parseMerge: parseGitLabMergeEvent,
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
  | { status: "accepted"; event: "ci_failure" | "merged" }
  | { status: "removed"; connections: number }
  | { status: "ignored"; reason: string };

const reply = (outcome: Outcome) => Response.json(outcome);
const ignored = (reason: string) => reply({ status: "ignored", reason });

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
  }
  return reply({ status: "removed", connections: connections.length });
}

/**
 * Handles a GitHub/GitLab webhook delivery: finds the connected repository,
 * verifies the signature with its connection's adapter (401 if invalid), which
 * resolves the organization (the connection's),
 * applies the repo's triggers and enqueues a review. It only writes and
 * publishes (no review work), so it answers well within the code host's
 * timeout. Unknown, disabled or disconnected repos and irrelevant events get
 * 200 without side effects; a delivery ID that was already acted on is a no-op.
 * A GitHub App uninstall removes the installation's connection.
 */
export async function handleWebhook(
  provider: ScmProvider,
  req: Request,
  deps: WebhookDeps,
): Promise<Response> {
  const { db, dispatcher, adapterFor = scmAdapterFor } = deps;
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
  const { repository, connection, adapter } = match;
  // The delivery belongs to the organization of the connection that verified it: the
  // reviews and jobs it creates hang off `repository`, which is in that organization.
  if (repository.organizationId !== connection.organizationId) {
    return ignored("unknown_repository");
  }

  const eventName = req.headers.get(spec.eventHeader);
  const deliveryId = req.headers.get(spec.deliveryHeader)?.trim();
  const delivery = deliveryId ? { provider, deliveryId } : null;
  const ci = spec.parseCi(eventName, body);
  if (ci) return handleCi({ ...deps, ...match, provider, delivery, ci });
  const merge = spec.parseMerge(eventName, body);
  if (merge) return handleMerge({ ...deps, ...match, provider, delivery, merge });
  const event = spec.parse(eventName, body);
  if (!event) {
    const comment = spec.parseComment(eventName, body);
    if (!comment) return ignored("unsupported_event");
    if (!repository.enabled || repository.disconnectedAt) return ignored("repository_disabled");
    return handleComment({ ...deps, ...match, provider, delivery, comment });
  }
  if (!repository.enabled || repository.disconnectedAt) return ignored("repository_disabled");
  const { triggers } = repository;
  if (event.kind === "open" && !triggers.onOpen) return ignored("trigger_disabled");
  if (event.kind === "push" && !triggers.onPush) return ignored("trigger_disabled");
  if (event.draft && !triggers.drafts) return ignored("draft");

  if (delivery && !(await claimWebhookDelivery(db, { ...delivery, repositoryId: repository.id }))) {
    return reply({ status: "duplicate" });
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
    if (result.status === "repository_unavailable" || result.status === "profile_not_found") {
      return ignored("repository_disabled");
    }
    if (delivery) await setWebhookDeliveryJob(db, delivery, result.jobId);
    if (result.status === "duplicate") return reply({ status: "duplicate", jobId: result.jobId });
    return reply({ status: "enqueued", reviewId: result.reviewId, jobId: result.jobId });
  } catch (error) {
    // Let the code host's redelivery try again.
    if (delivery) await releaseWebhookDelivery(db, delivery).catch(() => undefined);
    console.error(`${provider} webhook ${deliveryId ?? "(no delivery ID)"} failed`, error);
    return Response.json({ error: "internal_error" }, { status: 500 });
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
  },
): Promise<Response> {
  const { db, repository, delivery, comment } = input;
  const handle = connectionBotHandle(input.connection, input.handle);
  if (isOwnComment(comment.author, handle)) return ignored("own_comment");
  const command = parseBotCommand(comment.body, handle);
  if (!command) return ignored("no_mention");
  if (delivery && !(await claimWebhookDelivery(db, { ...delivery, repositoryId: repository.id }))) {
    return reply({ status: "duplicate" });
  }
  const task = async () => {
    try {
      await runBotCommand({ ...input, handle, command });
    } catch (error) {
      console.error(
        `${input.provider} @${handle} ${command.kind} on ${repository.fullPath}#${comment.number} failed`,
        error,
      );
    }
  };
  const defer = input.defer ?? ((run: () => Promise<void>) => run());
  await defer(task);
  return reply({ status: "accepted", command: command.kind });
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
  },
): Promise<Response> {
  const { db, repository, delivery, ci } = input;
  if (!ci.failed) return ignored("ci_not_failed");
  if (repository.disconnectedAt || !repository.ralphEnabled) return ignored("ralph_disabled");
  const lanes = await Promise.all([
    ...ci.prNumbers.map((n) => findLaneByPullRequest(db, repository.id, n)),
    ci.prNumbers.length === 0 && ci.branch
      ? findLaneByBranch(db, repository.id, ci.branch)
      : Promise.resolve(null),
  ]);
  if (!lanes.some(Boolean)) return ignored("not_ralph");
  if (delivery && !(await claimWebhookDelivery(db, { ...delivery, repositoryId: repository.id }))) {
    return reply({ status: "duplicate" });
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
    }
  };
  const defer = input.defer ?? ((run: () => Promise<void>) => run());
  await defer(task);
  return reply({ status: "accepted", event: "ci_failure" });
}

/**
 * A merged PR/MR: when it's a ralph lane's, the cleanup of its worktree and
 * branch starts (`cleanupMergedPullRequest`, via `defer`, since it confirms
 * the merge with the code host). Other PRs/MRs are ignored; a delivery ID
 * that was already acted on is a no-op.
 */
async function handleMerge(
  input: WebhookDeps & {
    repository: Repository;
    connection: ScmConnection;
    provider: ScmProvider;
    delivery: WebhookDeliveryRef | null;
    merge: MergeEvent;
  },
): Promise<Response> {
  const { db, repository, delivery, merge } = input;
  const found = await findLaneByPullRequest(db, repository.id, merge.number);
  if (!found) return ignored("not_ralph");
  if (delivery && !(await claimWebhookDelivery(db, { ...delivery, repositoryId: repository.id }))) {
    return reply({ status: "duplicate" });
  }
  const task = async () => {
    try {
      const organizationId = repository.organizationId;
      const linear = lazyLinearGateway(
        input.linear ?? (() => getLinearGatewayOrDisconnected({ db, organizationId })),
      );
      await cleanupMergedPullRequest(
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
        `${input.provider} merge of ${repository.fullPath}#${merge.number} failed to clean up`,
        error,
      );
    }
  };
  const defer = input.defer ?? ((run: () => Promise<void>) => run());
  await defer(task);
  return reply({ status: "accepted", event: "merged" });
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
