import "server-only";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import {
  accounts,
  createUser,
  hasPendingInvitation,
  sessions,
  type UiTheme,
  users,
} from "@omniralph/db";
import NextAuth, { type DefaultSession, type NextAuthConfig } from "next-auth";
import type { AdapterUser } from "next-auth/adapters";
import GitHub from "next-auth/providers/github";
import GitLab from "next-auth/providers/gitlab";
import { isEmailAllowed, parseAllowedDomains } from "@/lib/auth/allowlist";
import { ACCESS_DENIED_PATH, SIGN_IN_PATH } from "@/lib/auth/routes";
import { getDb } from "@/lib/db";
import { parseSoundPreference, type SoundPreference } from "@/lib/sound/preference";
import { parseTheme } from "@/lib/theme";

declare module "next-auth" {
  interface User {
    theme?: UiTheme | null;
    showAdvanced?: boolean;
    soundEnabled?: boolean;
    soundVolume?: number;
  }
  interface Session {
    user: {
      id: string;
      theme: UiTheme | null;
      showAdvanced: boolean;
      sound: SoundPreference;
    } & DefaultSession["user"];
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
      // New users belong to no organization; they're sent to onboarding. `signIn` has
      // already rejected accounts without an email, so `email` is set.
      createUser: async ({ name, email, emailVerified, image }) =>
        (await createUser(db, { name, email, emailVerified, image })) as AdapterUser,
    },
    // Database sessions: signing out or deleting a session takes effect on the next request.
    // The active organization isn't part of the session: `getCurrentUser` resolves it per
    // request, from this device's choice.
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
          hasPendingInvitation: (email) => hasPendingInvitation(db, email),
        });
        return allowed || ACCESS_DENIED_PATH;
      },
      async session({ session, user }) {
        session.user.id = user.id;
        session.user.theme = parseTheme(user.theme);
        session.user.showAdvanced = user.showAdvanced === true;
        session.user.sound = parseSoundPreference(user.soundEnabled, user.soundVolume);
        return session;
      },
    },
  };
}

// Lazy config so building the app doesn't require DATABASE_URL.
export const { handlers, auth, signIn, signOut } = NextAuth(() => authConfig());
