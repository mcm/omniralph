import "server-only";
import {
  getDesiredAgentVersion,
  getLatestAgentVersionCheck,
  setLatestAgentVersionCheck,
  TRACK_LATEST_AGENT_VERSION,
  type Database,
} from "@omniralph/db";
import { latestAgentVersion, NpmRegistryError } from "./npm";

/** How long a `latest` read from npm is used before it's read again. */
export const LATEST_MAX_AGE_MS = 5 * 60 * 1000;

/** The organization's agent version, with `latest` resolved. */
export interface OrganizationAgentVersion {
  /** The version agents without an override should run, or null when none is chosen (or known). */
  version: string | null;
  /** The organization follows the package's `latest` on npm. */
  tracksLatest: boolean;
  /** Tracking `latest`: why the last read of npm failed (`version` is then the last one read). */
  latestError: string | null;
  /** Tracking `latest`: when npm was last read. */
  latestCheckedAt: Date | null;
}

export interface ResolveOptions {
  now?: Date;
  /** Reads npm's `latest` (default: the registry, with `timeoutMs`). */
  fetchLatest?: () => Promise<string>;
  timeoutMs?: number;
}

/**
 * The version agents of the organization should run unless they have their own override.
 * With `latest` it's the version last read from npm, read again once it's older than
 * `LATEST_MAX_AGE_MS`; a failed read keeps the last version (and is retried after the same
 * time), so agents stay where they are while the registry can't be reached.
 */
export async function organizationAgentVersion(
  db: Database,
  organizationId: string,
  options: ResolveOptions = {},
): Promise<OrganizationAgentVersion> {
  const setting = await getDesiredAgentVersion(db, organizationId);
  if (setting !== TRACK_LATEST_AGENT_VERSION) {
    return { version: setting, tracksLatest: false, latestError: null, latestCheckedAt: null };
  }
  const now = options.now ?? new Date();
  const check = await getLatestAgentVersionCheck(db, organizationId);
  if (check && now.getTime() - check.checkedAt.getTime() < LATEST_MAX_AGE_MS) {
    return {
      version: check.version,
      tracksLatest: true,
      latestError: check.error,
      latestCheckedAt: check.checkedAt,
    };
  }
  const fetchLatest = options.fetchLatest ?? (() => latestAgentVersion(fetch, options.timeoutMs));
  let version = check?.version ?? null;
  let error: string | null = null;
  try {
    version = await fetchLatest();
  } catch (err) {
    if (!(err instanceof NpmRegistryError)) throw err;
    error = err.message;
    console.error(
      `Reading the latest agent version for organization ${organizationId} failed`,
      err,
    );
  }
  await setLatestAgentVersionCheck(db, organizationId, { version, error });
  return { version, tracksLatest: true, latestError: error, latestCheckedAt: now };
}

/** Records a fresh read of npm's `latest`, so heartbeats hand agents that version at once. */
export async function recordLatestAgentVersion(
  db: Database,
  organizationId: string,
  version: string,
): Promise<void> {
  await setLatestAgentVersionCheck(db, organizationId, { version, error: null });
}
