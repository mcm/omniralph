import "server-only";
import {
  claimWebhookDelivery,
  findRepositoriesByExternalId,
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
import { botHandle, isOwnComment, parseBotCommand } from "@/lib/mentions/commands";
import { runBotCommand } from "@/lib/mentions/handle";
import { enqueueReview } from "@/lib/review/enqueue";
import { scmAdapterFor } from "@/lib/scm/adapters";
import {
  githubInstallationId,
  parseGitHubCommentEvent,
  parseGitHubEvent,
  parseGitLabCommentEvent,
  parseGitLabEvent,
  webhookRepositoryId,
  type ChangeRequestEvent,
  type CommentEvent,
} from "./events";

/** Code-host lookups a handler may make stay well inside the 3s webhook budget. */
export const WEBHOOK_LOOKUP_TIMEOUT_MS = 2_000;

interface ProviderSpec {
  eventHeader: string;
  deliveryHeader: string;
  parse(eventName: string | null, body: unknown): ChangeRequestEvent | null;
  parseComment(eventName: string | null, body: unknown): CommentEvent | null;
}

const PROVIDERS: Record<ScmProvider, ProviderSpec> = {
  github: {
    eventHeader: "x-github-event",
    deliveryHeader: "x-github-delivery",
    parse: parseGitHubEvent,
    parseComment: parseGitHubCommentEvent,
  },
  gitlab: {
    eventHeader: "x-gitlab-event",
    deliveryHeader: "x-gitlab-event-uuid",
    parse: parseGitLabEvent,
    parseComment: parseGitLabCommentEvent,
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
  /** `BOT_HANDLE` (default `omniralph`). */
  handle?: string;
}

type Outcome =
  | { status: "enqueued"; reviewId: string; jobId: string }
  | { status: "duplicate"; jobId?: string }
  | { status: "accepted"; command: string }
  | { status: "ignored"; reason: string };

const reply = (outcome: Outcome) => Response.json(outcome);
const ignored = (reason: string) => reply({ status: "ignored", reason });

/**
 * Handles a GitHub/GitLab webhook delivery: finds the connected repository,
 * verifies the signature with its connection's adapter (401 if invalid),
 * applies the repo's triggers and enqueues a review. It only writes and
 * publishes (no review work), so it answers well within the code host's
 * timeout. Unknown, disabled or disconnected repos and irrelevant events get
 * 200 without side effects; a delivery ID that was already acted on is a no-op.
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
  const { repository, adapter } = match;

  const eventName = req.headers.get(spec.eventHeader);
  const deliveryId = req.headers.get(spec.deliveryHeader)?.trim();
  const delivery = deliveryId ? { provider, deliveryId } : null;
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
  const handle = input.handle ?? botHandle();
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
