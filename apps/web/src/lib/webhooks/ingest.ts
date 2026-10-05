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
} from "@omniralph/db";
import type { ChangeRequest, ScmAdapter } from "@omniralph/scm";
import type { JobDispatcher } from "@/lib/dispatch";
import { enqueueReview } from "@/lib/review/enqueue";
import { scmAdapterFor } from "@/lib/scm/adapters";
import {
  githubInstallationId,
  parseGitHubEvent,
  parseGitLabEvent,
  webhookRepositoryId,
  type ChangeRequestEvent,
} from "./events";

/** Code-host lookups a handler may make stay well inside the 3s webhook budget. */
export const WEBHOOK_LOOKUP_TIMEOUT_MS = 2_000;

interface ProviderSpec {
  eventHeader: string;
  deliveryHeader: string;
  parse(eventName: string | null, body: unknown): ChangeRequestEvent | null;
}

const PROVIDERS: Record<ScmProvider, ProviderSpec> = {
  github: {
    eventHeader: "x-github-event",
    deliveryHeader: "x-github-delivery",
    parse: parseGitHubEvent,
  },
  gitlab: {
    eventHeader: "x-gitlab-event",
    deliveryHeader: "x-gitlab-event-uuid",
    parse: parseGitLabEvent,
  },
};

export interface WebhookDeps {
  db: Database;
  dispatcher: JobDispatcher;
  adapterFor?: (db: Database, connection: ScmConnection) => ScmAdapter;
}

type Outcome =
  | { status: "enqueued"; reviewId: string; jobId: string }
  | { status: "duplicate"; jobId?: string }
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
  let match: { repository: Repository; adapter: ScmAdapter } | null = null;
  for (const { repository, connection } of candidates) {
    const adapter = adapterFor(db, connection);
    if (await adapter.verifyWebhook(req.headers, rawBody)) {
      match = { repository, adapter };
      break;
    }
  }
  if (!match) return Response.json({ error: "invalid_signature" }, { status: 401 });
  const { repository, adapter } = match;

  const event = spec.parse(req.headers.get(spec.eventHeader), body);
  if (!event) return ignored("unsupported_event");
  if (!repository.enabled || repository.disconnectedAt) return ignored("repository_disabled");
  const { triggers } = repository;
  if (event.kind === "open" && !triggers.onOpen) return ignored("trigger_disabled");
  if (event.kind === "push" && !triggers.onPush) return ignored("trigger_disabled");
  if (event.draft && !triggers.drafts) return ignored("draft");

  const deliveryId = req.headers.get(spec.deliveryHeader)?.trim();
  const delivery = deliveryId ? { provider, deliveryId } : null;
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
    if (result.status === "repository_unavailable") return ignored("repository_disabled");
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
