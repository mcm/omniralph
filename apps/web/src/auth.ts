import "server-only";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import {
  accounts,
  createUserWithInitialRole,
  isEmailAllowlisted,
  sessions,
  users,
} from "@omniralph/db";
import NextAuth, { type DefaultSession, type NextAuthConfig } from "next-auth";
import type { AdapterUser } from "next-auth/adapters";
import GitHub from "next-auth/providers/github";
import GitLab from "next-auth/providers/gitlab";
import { isEmailAllowed, parseAllowedDomains } from "@/lib/auth/allowlist";
import { isRole, type Role } from "@/lib/auth/roles";
import { ACCESS_DENIED_PATH, SIGN_IN_PATH } from "@/lib/auth/routes";
import { getDb } from "@/lib/db";

declare module "next-auth" {
  interface User {
    role?: Role;
  }
  interface Session {
    user: { id: string; role: Role } & DefaultSession["user"];
  }
}

/** GitLab base URL; set `AUTH_GITLAB_URL` for self-managed instances. */
export function gitlabBaseUrl(): string {
  const url = process.env.AUTH_GITLAB_URL || "https://gitlab.com";
  // The provider appends `oauth/authorize` etc., so the base must end in a slash.
  return url.endsWith("/") ? url : `${url}/`;
}

/** OAuth providers with credentials configured, in display order. */
export function configuredProviders(): { id: "github" | "gitlab"; name: string }[] {
  const providers: { id: "github" | "gitlab"; name: string }[] = [];
  if (process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET) {
    providers.push({ id: "github", name: "GitHub" });
  }
  if (process.env.AUTH_GITLAB_ID && process.env.AUTH_GITLAB_SECRET) {
    providers.push({ id: "gitlab", name: "GitLab" });
  }
  return providers;
}

function authConfig(): NextAuthConfig {
  const db = getDb();
  const adapter = DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
  });

  return {
    adapter: {
      ...adapter,
      // Assigns the role: the first user becomes admin, others get their allowlisted role.
      // `signIn` has already rejected accounts without an email, so `email` is set.
      createUser: async ({ name, email, emailVerified, image }) =>
        (await createUserWithInitialRole(db, { name, email, emailVerified, image })) as AdapterUser,
    },
    // Database sessions: removing a user or changing their role takes effect on the next request.
    session: { strategy: "database" },
    providers: [
      GitHub({
        clientId: process.env.AUTH_GITHUB_ID,
        clientSecret: process.env.AUTH_GITHUB_SECRET,
      }),
      GitLab({
        clientId: process.env.AUTH_GITLAB_ID,
        clientSecret: process.env.AUTH_GITLAB_SECRET,
        baseUrl: gitlabBaseUrl(),
      }),
    ],
    pages: { signIn: SIGN_IN_PATH, error: SIGN_IN_PATH },
    callbacks: {
      // Runs before the user row is created, so denied people never get an account.
      async signIn({ user }) {
        const allowed = await isEmailAllowed({
          email: user.email,
          allowedDomains: parseAllowedDomains(process.env.ALLOWED_EMAIL_DOMAINS),
          isAllowlisted: (email) => isEmailAllowlisted(db, email),
        });
        return allowed || ACCESS_DENIED_PATH;
      },
      session({ session, user }) {
        session.user.id = user.id;
        session.user.role = isRole(user.role) ? user.role : "member";
        return session;
      },
    },
  };
}

// Lazy config so building the app doesn't require DATABASE_URL.
export const { handlers, auth, signIn, signOut } = NextAuth(() => authConfig());
