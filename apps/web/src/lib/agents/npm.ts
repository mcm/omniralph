import "server-only";
import { AGENT_PACKAGE, AgentVersion } from "@omniralph/shared";

/** The agent package's registry document (`@` kept, `/` escaped, as npm does). */
export const AGENT_REGISTRY_URL = `https://registry.npmjs.org/${AGENT_PACKAGE.replace("/", "%2f")}`;

/** `NPM_TOKEN`, which can read the restricted agent package; null when unset. */
export function npmToken(): string | null {
  return process.env.NPM_TOKEN?.trim() || null;
}

export class NpmRegistryError extends Error {
  override name = "NpmRegistryError";
}

/**
 * The agent package's `latest` dist-tag, read from the npm registry with
 * `NPM_TOKEN` (the package is restricted).
 */
export async function latestAgentVersion(
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchFn(AGENT_REGISTRY_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        // The abbreviated metadata document: dist-tags without every version's manifest.
        accept: "application/vnd.npm.install-v1+json",
      },
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
  } catch (error) {
    throw new NpmRegistryError(
      `couldn't reach the npm registry (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    // npm answers 404 for restricted packages the token can't read.
    throw new NpmRegistryError(
      `the npm registry answered ${response.status}; check that NPM_TOKEN can read ${AGENT_PACKAGE}`,
    );
  }
  if (!response.ok) throw new NpmRegistryError(`the npm registry answered ${response.status}`);
  const body = (await response.json().catch(() => null)) as {
    "dist-tags"?: { latest?: unknown };
  } | null;
  const latest = AgentVersion.safeParse(body?.["dist-tags"]?.latest);
  if (!latest.success) throw new NpmRegistryError("the npm registry didn't list a latest version");
  return latest.data;
}
