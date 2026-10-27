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
    super(
      "The organization has no Linear workspace connected (Settings › Connections › Add connection)",
    );
    this.name = "LinearNotConnectedError";
  }
}

export function needsRefresh(credentials: LinearCredentials, now: number): boolean {
  if (!credentials.refreshToken || !credentials.expiresAt) return false;
  return Date.parse(credentials.expiresAt) - now < REFRESH_MARGIN_MS;
}

export interface LinearGatewayOptions {
  db: Database;
  /** The organization whose connected workspace to use. */
  organizationId: string;
  config?: LinearOAuthConfig | null;
  now?: () => number;
  /** Encryption key override (tests). */
  key?: string | Buffer;
  createGateway?: (accessToken: string) => LinearGateway;
  /**
   * Longest wait for a token refresh while the current token hasn't expired
   * yet: past it (or when the refresh fails) the current token is used and
   * the refresh carries on in the background. Unset waits for the refresh.
   */
  refreshTimeoutMs?: number;
}

/** Resolves to `fallback` after `ms` unless `promise` settles first (its rejection propagates). */
function settleWithin<T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<F>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** In-process refreshes in flight, by integration ID (the DB row lock covers other processes). */
const refreshing = new Map<string, Promise<LinearCredentials | null>>();

/**
 * A gateway for the organization's connected Linear workspace with a valid access token. A
 * token that expires within 5 minutes is refreshed first and persisted; the
 * refresh runs under the integration's row lock and re-checks the stored
 * token, so concurrent callers (in any process) refresh once and never
 * overwrite a newer token with an older one. With `refreshTimeoutMs`, a
 * still-valid token is used when the refresh is slow or fails.
 */
export async function getLinearGateway(options: LinearGatewayOptions): Promise<LinearGateway> {
  const { db, organizationId, key } = options;
  const now = options.now ?? Date.now;
  const createGateway = options.createGateway ?? ((token) => new SdkLinearGateway(token));
  const integration = await getIntegrationWithCredentials<LinearCredentials>(
    db,
    organizationId,
    "linear",
    key,
  );
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
    const current = credentials;
    const stillValid = !!current.expiresAt && Date.parse(current.expiresAt) > now();
    if (options.refreshTimeoutMs !== undefined && stillValid) {
      const TIMED_OUT = "timed out" as const;
      const refreshed = await settleWithin(pending, options.refreshTimeoutMs, TIMED_OUT).catch(
        (error: unknown) => {
          console.error("Refreshing the Linear token failed; using the current token", error);
          return TIMED_OUT;
        },
      );
      if (refreshed === TIMED_OUT) {
        // The refresh carries on for later callers; don't leave its failure unhandled.
        pending.catch(() => undefined);
        return createGateway(current.accessToken);
      }
      credentials = refreshed;
    } else {
      credentials = await pending;
    }
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

/**
 * A gateway that is only loaded (`load`, once) on its first call, so paths
 * that may not touch Linear at all (e.g. follow-ups of a run from chat) never
 * read or refresh the workspace's token. A failed load fails that call and is
 * tried again by the next one.
 */
export function lazyLinearGateway(load: () => Promise<LinearGateway>): LinearGateway {
  let loading: Promise<LinearGateway> | undefined;
  const gateway = () => {
    loading ??= load().catch((error: unknown) => {
      loading = undefined;
      throw error;
    });
    return loading;
  };
  return new Proxy({} as LinearGateway, {
    // Not a thenable, so it can be returned from async functions.
    get: (_target, prop) =>
      prop === "then"
        ? undefined
        : async (...args: unknown[]) => {
            const loaded = await gateway();
            const method = loaded[prop as keyof LinearGateway] as (...a: unknown[]) => unknown;
            return method.apply(loaded, args);
          },
  });
}

/** The organization's workspace gateway, or a disconnected one when it has none connected. */
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
