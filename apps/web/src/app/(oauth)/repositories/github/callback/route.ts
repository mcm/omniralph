import { consumeOAuthState, findScmConnection, upsertScmConnection } from "@omniralph/db";
import { getInstallation } from "@omniralph/scm";
import { NextResponse, type NextRequest } from "next/server";
import { membership } from "@/lib/api/scope";
import { githubAccountType } from "@/lib/connections/github-installation";
import { AuthorizationError, hasRole } from "@/lib/auth/roles";
import { ACCESS_DENIED_PATH, SIGN_IN_PATH } from "@/lib/auth/routes";
import { requireUser, type OrgUser } from "@/lib/auth/session";
import { connectingWithHistory, settingsActor } from "@/lib/settings-history/sections";
import { readSignedState } from "@/lib/auth/signed-state";
import { getDb } from "@/lib/db";
import {
  getGitHubAppAuth,
  githubApiUrl,
  GITHUB_CALLBACK_PATH,
  GITHUB_INSTALL_COOKIE,
  GITHUB_INSTALL_STATE_PURPOSE,
} from "@/lib/scm/github-app";
import { liveRoute } from "@/lib/live/request";

/** The Repos page with the add-repo sheet open on a GitHub connection's picker. */
function pickerPath(connectionId: string): string {
  return `/repos?${new URLSearchParams({ add: "github", connection: connectionId })}`;
}

/** The Repos page telling why connecting GitHub didn't work. */
function statusPath(status: string): string {
  return `/repos?github=${status}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether the user is an admin of `organizationId` (any of their organizations). */
async function isAdminOf(user: OrgUser, organizationId: string): Promise<boolean> {
  if (organizationId !== user.organization.id && !UUID.test(organizationId)) return false;
  const organization = await membership(user, organizationId);
  return organization !== null && hasRole(organization, "admin");
}

/**
 * The GitHub App's Setup URL: GitHub redirects here after the app is installed (or its
 * repositories changed) with `installation_id`, `setup_action` and the `state` from
 * `/repositories/github/install`. Stores the installation as a connection of the
 * organization in the signed state (where the user must be an admin) and continues to its
 * repository picker on the Repos page. An installation already connected to another
 * organization is refused. Without a valid state (e.g. the installation was changed on
 * GitHub), only an installation of an organization the user is an admin of is opened.
 */
async function get(request: NextRequest) {
  const to = (path: string) => {
    const response = NextResponse.redirect(new URL(path, request.url));
    response.cookies.delete({ name: GITHUB_INSTALL_COOKIE, path: GITHUB_CALLBACK_PATH });
    return response;
  };
  let admin;
  try {
    admin = await requireUser();
  } catch (error) {
    if (!(error instanceof AuthorizationError)) throw error;
    return to(
      error.reason === "unauthenticated" ? SIGN_IN_PATH : `${ACCESS_DENIED_PATH}?reason=forbidden`,
    );
  }

  const params = request.nextUrl.searchParams;
  // An org member without install rights only *requested* the installation.
  if (params.get("setup_action") === "request") return to(statusPath("requested"));
  const installationId = Number(params.get("installation_id"));
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    return to(statusPath("invalid"));
  }

  const db = getDb();
  const signed = await readSignedState(GITHUB_INSTALL_STATE_PURPOSE, params.get("state"), {
    userId: admin.id,
    nonce: request.cookies.get(GITHUB_INSTALL_COOKIE)?.value,
  });
  // Only an admin of the state's organization connects to it.
  if (signed && !(await isAdminOf(admin, signed.organizationId))) {
    return to(`${ACCESS_DENIED_PATH}?reason=forbidden`);
  }
  // A state works once.
  const validState =
    signed !== null && (await consumeOAuthState(db, signed.nonce, signed.expiresAt));
  if (!signed || !validState) {
    const existing = await findScmConnection(db, "github", githubApiUrl(), String(installationId));
    return to(
      existing && (await isAdminOf(admin, existing.organizationId))
        ? pickerPath(existing.id)
        : statusPath("invalid_state"),
    );
  }
  const organizationId = signed.organizationId;

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
    return to(statusPath(status === 404 ? "invalid" : "error"));
  }
  const existing = await findScmConnection(db, "github", githubApiUrl(), String(installation.id));
  const connection = await connectingWithHistory(
    db,
    settingsActor(admin),
    organizationId,
    existing?.organizationId === organizationId ? existing.id : null,
    (tx) =>
      upsertScmConnection(tx, {
        organizationId,
        provider: "github",
        name: installation.account,
        baseUrl: githubApiUrl(),
        externalId: String(installation.id),
        accountType: githubAccountType(installation.accountType),
        credentials: {},
        createdBy: admin.id,
      }),
    (saved) => saved?.id ?? null,
  );
  if (!connection) return to(statusPath("other_organization"));
  return to(pickerPath(connection.id));
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

export const GET = liveRoute(get);
