// The organization journey end to end, through the real actions and pages: a new user
// signs in, creates an organization, connects a repository and enrolls an agent, invites a
// teammate who gets past the sign-in gate thanks to the invitation, accepts it and sees
// the shared repositories and harnesses. Roles are per organization.
import { randomBytes } from "node:crypto";
import {
  closeDb,
  connectRepository,
  createHarnessEnrollment,
  createDb,
  enrollHarness,
  getActiveOrganization,
  hasPendingInvitation,
  listPendingInvitationsForEmail,
  runMigrations,
  upsertScmConnection,
  users,
  type Database,
} from "@omniralph/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { JSX } from "react";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isEmailAllowed } from "@/lib/auth/allowlist";
import { assertRole, AuthorizationError, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  userId: null as string | null,
  cookies: new Map<string, string>(),
}));
// This browser's cookies.
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = state.cookies.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => void state.cookies.set(name, value),
  }),
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
// The signed-in user as the session would build them: their real active organization and role.
vi.mock("@/lib/auth/session", async () => {
  const { getActiveOrganization, getUserById } = await import("@omniralph/db");
  const current = async () => {
    if (state.userId === null) return null;
    const user = await getUserById(state.db, state.userId);
    const active = await getActiveOrganization(state.db, state.userId);
    return {
      id: state.userId,
      organization: active ? { id: active.id, name: active.name } : null,
      role: active?.role ?? null,
      name: user?.name ?? null,
      email: user?.email ?? null,
      image: null,
      theme: null,
    };
  };
  return {
    getCurrentUser: current,
    requireSignedInUser: async () => {
      const user = await current();
      if (!user) throw new AuthorizationError("You must be signed in.", "unauthenticated");
      return user;
    },
    requireUser: async (role: Role = "member") => assertRole(await current(), role),
    requirePageUser: async (role: Role = "member") => assertRole(await current(), role),
  };
});
vi.mock("@/lib/dispatch", () => ({ getDispatcher: () => ({}) }));
vi.mock("@/lib/scm/github-app", () => ({
  getGitHubAppAuth: () => ({}),
  getGitHubInstallUrl: async () => null,
  GITHUB_INSTALL_PATH: "/repositories/github/install",
}));
// Views are client components; the tests read the props the pages pass them.
vi.mock("./repositories/repositories-view", () => ({ RepositoriesView: () => null }));
vi.mock("./agents/agents-view", () => ({ AgentsView: () => null }));
vi.mock("./settings/organization/organization-settings-view", () => ({
  OrganizationSettingsView: () => null,
}));
vi.mock("../(auth)/onboarding/onboarding-view", () => ({ OnboardingView: () => null }));

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const { acceptInvitationAction, createOrganizationAction, switchOrganization } =
  await import("@/lib/organizations/actions");
const { inviteMember, changeMemberRole } = await import("./settings/organization/actions");
const { default: RepositoriesPage } = await import("./repositories/page");
const { default: AgentsPage } = await import("./agents/page");
const { default: OrganizationSettingsPage } = await import("./settings/organization/page");
const { default: OnboardingPage } = await import("../(auth)/onboarding/page");

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

/** `isEmailAllowed` as `auth.ts` calls it, with no `ALLOWED_EMAIL_DOMAINS`. */
const signInAllowed = (db: Database, email: string) =>
  isEmailAllowed({
    email,
    allowedDomains: [],
    hasPendingInvitation: (e) => hasPendingInvitation(db, e),
  });

const props = (element: JSX.Element) => JSON.stringify(element.props);

describe.skipIf(!dockerAvailable)("organization onboarding journey", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    state.db = db;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await container?.stop();
  });

  async function signUp(email: string) {
    const [row] = await db.insert(users).values({ email, name: email }).returning();
    state.userId = row!.id;
    return row!;
  }

  it("creates an organization, invites a teammate who signs in, accepts and sees the shared repositories and agents", async () => {
    // A new user without an organization creates one and becomes its admin.
    const founder = await signUp("founder@journey.io");
    expect(await getActiveOrganization(db, founder.id)).toBeNull();
    expect(await createOrganizationAction("Journey")).toEqual({ ok: true });
    const org = (await getActiveOrganization(db, founder.id))!;
    expect(org).toMatchObject({ name: "Journey", role: "admin" });

    // The admin connects a repository and enrolls an agent in it.
    const connection = (await upsertScmConnection(db, {
      organizationId: org.id,
      provider: "github",
      name: "journey-installation",
      baseUrl: "https://api.github.com",
      externalId: "9001",
      credentials: {},
    }))!;
    const repo = await connectRepository(db, {
      connectionId: connection.id,
      provider: "github",
      externalId: "1",
      fullPath: "journey/shared-app",
    });
    const enrollment = await createHarnessEnrollment(db, {
      organizationId: org.id,
      name: "journey-agent",
      createdBy: founder.id,
    });
    const { harnessId } = (await enrollHarness(db, {
      enrollmentToken: enrollment.token,
      name: "journey-agent",
      version: "1.0.0",
      capabilities: ["review"],
    }))!;

    // The teammate's email isn't in ALLOWED_EMAIL_DOMAINS: no sign-in until invited.
    const teammateEmail = "teammate@elsewhere.dev";
    expect(await signInAllowed(db, teammateEmail)).toBe(false);
    expect(await inviteMember(teammateEmail, "member")).toEqual({ ok: true });
    expect(await signInAllowed(db, teammateEmail)).toBe(true);
    expect(await signInAllowed(db, "stranger@elsewhere.dev")).toBe(false);

    // The teammate signs in, sees the invitation on onboarding and accepts it.
    const teammate = await signUp(teammateEmail);
    expect(await getActiveOrganization(db, teammate.id)).toBeNull();
    const [invitation] = await listPendingInvitationsForEmail(db, teammateEmail);
    expect(props(await OnboardingPage())).toContain(invitation!.id);
    expect(await acceptInvitationAction(invitation!.id, org.id)).toEqual({ ok: true });
    expect(await getActiveOrganization(db, teammate.id)).toMatchObject({
      id: org.id,
      role: "member",
    });
    // Accepted invitations no longer open the sign-in gate.
    expect(await hasPendingInvitation(db, teammateEmail)).toBe(false);

    // The teammate sees the organization's repositories, agents and members.
    const repositories = props(await RepositoriesPage({ searchParams: Promise.resolve({}) }));
    expect(repositories).toContain(repo.id);
    expect(repositories).toContain("journey/shared-app");
    expect(props(await AgentsPage())).toContain(harnessId);
    const settings = props(await OrganizationSettingsPage());
    expect(settings).toContain(founder.email!);
    expect(settings).toContain(teammateEmail);

    // As a member, the teammate can't invite or change roles.
    expect(await inviteMember("another@elsewhere.dev", "member")).toMatchObject({ ok: false });
    expect(await changeMemberRole(teammate.id, "admin")).toMatchObject({ ok: false });
  });

  it("keeps roles per organization and follows the active one when switching", async () => {
    const alice = await signUp("alice@roles.io");
    expect(await createOrganizationAction("Alice's")).toEqual({ ok: true });
    const alices = (await getActiveOrganization(db, alice.id))!;

    const bob = await signUp("bob@roles.io");
    expect(await createOrganizationAction("Bob's")).toEqual({ ok: true });
    const bobs = (await getActiveOrganization(db, bob.id))!;
    expect(await inviteMember(alice.email!, "member")).toEqual({ ok: true });

    state.userId = alice.id;
    const [invitation] = await listPendingInvitationsForEmail(db, alice.email!);
    expect(await acceptInvitationAction(invitation!.id, bobs.id)).toEqual({ ok: true });

    // Member in Bob's organization: admin actions are refused there.
    expect(await getActiveOrganization(db, alice.id)).toMatchObject({
      id: bobs.id,
      role: "member",
    });
    expect(await inviteMember("carol@roles.io", "member")).toMatchObject({ ok: false });

    // Still admin of her own organization once she switches back.
    expect(await switchOrganization(alices.id)).toEqual({ ok: true });
    expect(await getActiveOrganization(db, alice.id)).toMatchObject({
      id: alices.id,
      role: "admin",
    });
    expect(await inviteMember("carol@roles.io", "member")).toEqual({ ok: true });

    // The sole admin can't demote themselves: every organization keeps an admin.
    expect(await changeMemberRole(alice.id, "member")).toMatchObject({ ok: false });
    expect(await getActiveOrganization(db, alice.id)).toMatchObject({ role: "admin" });
  });
});
