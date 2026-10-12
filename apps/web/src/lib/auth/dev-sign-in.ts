import "server-only";
import { normalizeEmail, sessions, users, type Database } from "@omniralph/db";
import { eq } from "drizzle-orm";
import { SESSION_COOKIES } from "./routes";

/** Auth.js's default database session lifetime. */
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Whether the dev sign-in exists: only with `OMNIRALPH_DEV_SIGNIN=1`, and
 * never in a production build, whatever the variable says.
 */
export function devSignInEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV !== "production" && env.OMNIRALPH_DEV_SIGNIN === "1";
}

/** The Auth.js session cookie for a request URL (the `__Secure-` variant over HTTPS). */
export function sessionCookieName(url: URL): (typeof SESSION_COOKIES)[number] {
  return url.protocol === "https:" ? SESSION_COOKIES[1] : SESSION_COOKIES[0];
}

/**
 * Creates an Auth.js database session for the user with `email`, or returns
 * `null` when there is no such user.
 */
export async function createDevSession(
  db: Database,
  email: string,
  now = new Date(),
): Promise<{ sessionToken: string; expires: Date } | null> {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normalizeEmail(email)));
  if (!user) return null;
  const session = {
    sessionToken: crypto.randomUUID(),
    userId: user.id,
    expires: new Date(now.getTime() + SESSION_MAX_AGE_MS),
  };
  await db.insert(sessions).values(session);
  return { sessionToken: session.sessionToken, expires: session.expires };
}
