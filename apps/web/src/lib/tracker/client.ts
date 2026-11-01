import "server-only";
import { listIntegratedOrganizationIds, type Database } from "@omniralph/db";
import { TRACKER_PROVIDERS, type TrackerGateway, type TrackerProvider } from "@omniralph/tracker";
import type { TrackerConnectionOptions } from "./adapter";
import { trackerAdapter } from "./adapters";
import { TrackerNotConnectedError } from "./errors";

export { TrackerNotConnectedError };

/** The provider an organization's tracker is, until rows record theirs: Linear, the only one. */
export const DEFAULT_TRACKER_PROVIDER: TrackerProvider = "linear";

export interface TrackerGatewayOptions extends TrackerConnectionOptions {
  /** Which tracker (default: {@link DEFAULT_TRACKER_PROVIDER}). */
  provider?: TrackerProvider;
}

/**
 * A gateway for the organization's connected tracker, with valid credentials
 * (refreshed first when they are about to expire). Throws a
 * {@link TrackerNotConnectedError} when the organization has none connected.
 */
export async function getTrackerGateway(options: TrackerGatewayOptions): Promise<TrackerGateway> {
  const { provider = DEFAULT_TRACKER_PROVIDER, ...connection } = options;
  return trackerAdapter(provider).getGateway(connection);
}

/**
 * A gateway whose every call fails with a {@link TrackerNotConnectedError}, for
 * code that writes to the tracker best-effort (e.g. stopping a run from the
 * control panel while no tracker is connected).
 */
export function disconnectedTrackerGateway(
  provider: TrackerProvider = DEFAULT_TRACKER_PROVIDER,
): TrackerGateway {
  return trackerAdapter(provider).disconnectedGateway();
}

/** The organization's tracker gateway, or a disconnected one when it has none connected. */
export async function getTrackerGatewayOrDisconnected(
  options: TrackerGatewayOptions,
): Promise<TrackerGateway> {
  try {
    return await getTrackerGateway(options);
  } catch (error) {
    if (error instanceof TrackerNotConnectedError)
      return disconnectedTrackerGateway(options.provider);
    throw error;
  }
}

/**
 * The organization's tracker gateway (a disconnected one when it has none),
 * only loaded on its first call, so paths that may not touch the tracker at
 * all (e.g. follow-ups of a run from chat) never read or refresh its
 * credentials. A failed load fails that call and is tried again by the next.
 * `load` replaces how it is loaded (e.g. a test's gateway).
 */
export function lazyTrackerGateway(
  options: TrackerGatewayOptions & { load?: () => Promise<TrackerGateway> },
): TrackerGateway {
  const { provider = DEFAULT_TRACKER_PROVIDER, load, ...connection } = options;
  return trackerAdapter(provider).lazyGateway(
    load ?? (() => getTrackerGatewayOrDisconnected({ ...connection, provider })),
  );
}

/** The organizations with a tracker connected (each once, in connection order per provider). */
export async function listTrackerOrganizationIds(db: Database): Promise<string[]> {
  const ids = new Set<string>();
  for (const provider of TRACKER_PROVIDERS) {
    for (const id of await listIntegratedOrganizationIds(db, provider)) ids.add(id);
  }
  return [...ids];
}
