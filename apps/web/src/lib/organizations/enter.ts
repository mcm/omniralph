import "server-only";
import { jwtVerify, SignJWT } from "jose";
import { stateKey } from "@/lib/auth/signed-state";
import { ENTER_ORGANIZATION_PATH } from "@/lib/auth/routes";

/**
 * Switching organizations through {@link ENTER_ORGANIZATION_PATH}: detail pages redirect
 * there to open a resource of another of the user's organizations (pages can't set
 * cookies). The switch is a GET, which another site can trigger with a link, so it takes
 * a signed `token` only our own redirect can make: bound to the user, the organization
 * and where to go next, and valid for {@link ENTER_ORGANIZATION_TTL_SECONDS}.
 */
export const ENTER_ORGANIZATION_TTL_SECONDS = 60;

const PURPOSE = "enter-organization";
const AUDIENCE = `omniralph:${PURPOSE}`;

/** `/api/organizations/enter?token=…` switching `userId` to `organizationId`, then going to `next`. */
export async function createEnterOrganizationPath(
  input: { userId: string; organizationId: string; next: string },
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): Promise<string> {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const token = await new SignJWT({ org: input.organizationId, next: input.next })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(input.userId)
    .setAudience(AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ENTER_ORGANIZATION_TTL_SECONDS)
    .sign(stateKey(PURPOSE, env));
  return `${ENTER_ORGANIZATION_PATH}?${new URLSearchParams({ token })}`;
}

/** The organization and next path of `token` when we signed it for `userId` and it hasn't expired. */
export async function readEnterOrganizationToken(
  token: string | null | undefined,
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): Promise<{ organizationId: string; next: string } | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, stateKey(PURPOSE, env), {
      algorithms: ["HS256"],
      audience: AUDIENCE,
      subject: userId,
      currentDate: now,
      requiredClaims: ["exp"],
    });
    const { org, next } = payload;
    if (typeof org !== "string" || typeof next !== "string") return null;
    return { organizationId: org, next };
  } catch {
    return null;
  }
}
