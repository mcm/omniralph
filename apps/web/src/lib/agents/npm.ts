import "server-only";
import { AGENT_PACKAGE, AgentVersion } from "@omniralph/shared";

/** The agent package's registry document (`@` kept, `/` escaped, as npm does). */
export const AGENT_REGISTRY_URL = `https://registry.npmjs.org/${AGENT_PACKAGE.replace("/", "%2f")}`;

export class NpmRegistryError extends Error {
  override name = "NpmRegistryError";
}

/** The agent package's `latest` dist-tag, read from the npm registry (the package is public). */
export async function latestAgentVersion(
  fetchFn: typeof fetch = fetch,
  timeoutMs = 15_000,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchFn(AGENT_REGISTRY_URL, {
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
  return latest.data;
}
