import "server-only";
import {
  getIntegrationWithCredentials,
  updateIntegrationCredentials,
  type Database,
} from "@omniralph/db";
import { SdkLinearGateway, type LinearGateway } from "./gateway";
import {
  linearOAuthConfig,
  refreshCredentials,
  type LinearCredentials,
  type LinearOAuthConfig,
} from "./oauth";

/** Tokens are refreshed when they expire within this window. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export class LinearNotConnectedError extends Error {
  constructor() {
    super("No Linear workspace is connected (Settings › Integrations)");
    this.name = "LinearNotConnectedError";
  }
}

export function needsRefresh(credentials: LinearCredentials, now: number): boolean {
  if (!credentials.refreshToken || !credentials.expiresAt) return false;
  return Date.parse(credentials.expiresAt) - now < REFRESH_MARGIN_MS;
}

export interface LinearGatewayOptions {
  db: Database;
  config?: LinearOAuthConfig | null;
  now?: () => number;
  /** Encryption key override (tests). */
  key?: string | Buffer;
  createGateway?: (accessToken: string) => LinearGateway;
}

/** In-process refreshes in flight, by integration ID (the DB row lock covers other processes). */
const refreshing = new Map<string, Promise<LinearCredentials | null>>();

/**
 * A gateway for the connected Linear workspace with a valid access token. A
 * token that expires within 5 minutes is refreshed first and persisted; the
 * refresh runs under the integration's row lock and re-checks the stored
 * token, so concurrent callers (in any process) refresh once and never
 * overwrite a newer token with an older one.
 */
export async function getLinearGateway(options: LinearGatewayOptions): Promise<LinearGateway> {
  const { db, key } = options;
  const now = options.now ?? Date.now;
  const createGateway = options.createGateway ?? ((token) => new SdkLinearGateway(token));
  const integration = await getIntegrationWithCredentials<LinearCredentials>(db, "linear", key);
  if (!integration) throw new LinearNotConnectedError();
  let credentials: LinearCredentials | null = integration.credentials;
  if (needsRefresh(credentials, now())) {
    let pending = refreshing.get(integration.id);
    if (!pending) {
      const config = options.config === undefined ? linearOAuthConfig() : options.config;
      if (!config) throw new Error("LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET must be set");
      pending = updateIntegrationCredentials<LinearCredentials>(
        db,
        integration.id,
        async (current) =>
          needsRefresh(current, now()) ? refreshCredentials(config, current, now()) : null,
        key,
      ).finally(() => refreshing.delete(integration.id));
      refreshing.set(integration.id, pending);
    }
    credentials = await pending;
    if (!credentials) throw new LinearNotConnectedError();
  }
  return createGateway(credentials.accessToken);
}

/**
 * A gateway whose every call fails with `LinearNotConnectedError`, for code
 * that writes to Linear best-effort (e.g. stopping a run from the control
 * panel while no workspace is connected).
 */
export function disconnectedLinearGateway(): LinearGateway {
  return new Proxy({} as LinearGateway, {
    // Not a thenable, so it can be returned from async functions.
    get: (_target, prop) =>
      prop === "then"
        ? undefined
        : async () => {
            throw new LinearNotConnectedError();
          },
  });
}

/** The connected workspace's gateway, or a disconnected one when none is connected. */
export async function getLinearGatewayOrDisconnected(
  options: LinearGatewayOptions,
): Promise<LinearGateway> {
  try {
    return await getLinearGateway(options);
  } catch (error) {
    if (error instanceof LinearNotConnectedError) return disconnectedLinearGateway();
    throw error;
  }
}
