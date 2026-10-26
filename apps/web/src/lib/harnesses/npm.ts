import "server-only";
import {
  AGENT_MIN_VERSION,
  AGENT_PACKAGE,
  AgentVersion,
  agentVersionAtLeast,
} from "@omniralph/shared";

/** The harness package's registry document (`@` kept, `/` escaped, as npm does). */
export const HARNESS_REGISTRY_URL = `https://registry.npmjs.org/${AGENT_PACKAGE.replace("/", "%2f")}`;

export class NpmRegistryError extends Error {
  override name = "NpmRegistryError";
}

/**
 * The harness package's `latest` dist-tag, read from the npm registry (the package is public).
 * A `latest` below `AGENT_MIN_VERSION` (the deprecated 0.x releases under the same name) is a
 * failed read: agents are never offered one.
 */
export async function latestHarnessVersion(
  fetchFn: typeof fetch = fetch,
  timeoutMs = 15_000,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchFn(HARNESS_REGISTRY_URL, {
      headers: {
        // The abbreviated metadata document: dist-tags without every version's manifest.
        accept: "application/vnd.npm.install-v1+json",
      },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (error) {
    throw new NpmRegistryError(
      `couldn't reach the npm registry (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (response.status === 404) {
    throw new NpmRegistryError(`the npm registry doesn't know ${AGENT_PACKAGE} (404)`);
  }
  if (!response.ok) throw new NpmRegistryError(`the npm registry answered ${response.status}`);
  const body = (await response.json().catch(() => null)) as {
    "dist-tags"?: { latest?: unknown };
  } | null;
  const latest = AgentVersion.safeParse(body?.["dist-tags"]?.latest);
  if (!latest.success) throw new NpmRegistryError("the npm registry didn't list a latest version");
  if (!agentVersionAtLeast(latest.data, AGENT_MIN_VERSION)) {
    throw new NpmRegistryError(`No ${AGENT_PACKAGE} ${AGENT_MIN_VERSION} or later on npm yet`);
  }
  return latest.data;
}
