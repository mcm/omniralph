import { upsertScmConnection } from "@omniralph/db";
import { getInstallation } from "@omniralph/scm";
import { NextResponse, type NextRequest } from "next/server";
import { AuthorizationError } from "@/lib/auth/roles";
import { ACCESS_DENIED_PATH, SIGN_IN_PATH } from "@/lib/auth/routes";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { getGitHubAppAuth, githubApiUrl } from "@/lib/scm/github-app";

/**
 * The GitHub App's Setup URL: GitHub redirects here after the app is installed (or its
 * repositories changed) with `installation_id` and `setup_action`. Stores the installation
 * as a connection and continues to its repository picker.
 */
export async function GET(request: NextRequest) {
  const to = (path: string) => NextResponse.redirect(new URL(path, request.url));
  let admin;
  try {
    admin = await requireUser("admin");
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    return to(
      error.reason === "unauthenticated" ? SIGN_IN_PATH : `${ACCESS_DENIED_PATH}?reason=forbidden`,
    );
  }

  const params = request.nextUrl.searchParams;
  // An org member without install rights only *requested* the installation.
  if (params.get("setup_action") === "request") return to("/repositories?github=requested");
  const installationId = Number(params.get("installation_id"));
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    return to("/repositories?github=invalid");
  }

  // Only installations of our own app resolve (others 404), so a forged ID can't be stored.
  let installation;
  try {
    installation = await getInstallation(getGitHubAppAuth(), installationId);
  } catch (error) {
    const status = errorStatus(error);
    console.error(
      `GitHub installation ${installationId} lookup failed`,
      // Name, status and message only: Octokit errors also carry the request (headers included).
      { status, name: errorName(error), message: errorMessage(error) },
    );
    return to(`/repositories?github=${status === 404 ? "invalid" : "error"}`);
  }
  const connection = await upsertScmConnection(getDb(), {
    provider: "github",
    name: installation.account,
    baseUrl: githubApiUrl(),
    externalId: String(installation.id),
    credentials: {},
    createdBy: admin.id,
  });
  return to(`/repositories/github/${connection.id}`);
}

function errorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
