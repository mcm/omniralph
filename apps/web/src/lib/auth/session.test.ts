import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ORGANIZATION_COOKIE, ORGANIZATION_SCOPE_COOKIE } from "./routes";

vi.mock("server-only", () => ({}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof React>()),
  // No request scope in tests: don't share one user between them.
  cache: <T>(fn: T) => fn,
}));

const ALPHA = "11111111-1111-4111-8111-111111111111";
const BETA = "22222222-2222-4222-8222-222222222222";
const organizations = {
  [ALPHA]: { id: ALPHA, name: "Alpha", role: "admin" as const },
  [BETA]: { id: BETA, name: "Beta", role: "member" as const },
};

const state = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  scopeCookie: undefined as string | undefined,
  /** The organizations the user is a member of. */
  memberOf: [] as string[],
  /** The one they last picked on any device. */
  lastPicked: null as string | null,
}));
vi.mock("@/auth", () => ({
  auth: async () => ({
    user: { id: "user-1", name: "Ada", email: null, image: null, theme: null, showAdvanced: false },
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect ${path}`);
  },
}));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value =
        name === ORGANIZATION_COOKIE
          ? state.cookie
          : name === ORGANIZATION_SCOPE_COOKIE
            ? state.scopeCookie
            : undefined;
      return value === undefined ? undefined : { name, value };
    },
  }),
}));
vi.mock("@omniralph/db", () => {
  const member = (id: string | null) =>
    id && state.memberOf.includes(id) ? organizations[id as keyof typeof organizations] : null;
  return {
    getMemberOrganization: async (_db: unknown, input: { organizationId: string }) =>
      member(input.organizationId),
    getActiveOrganization: async () => member(state.lastPicked),
    listOrganizationsForUser: async () =>
      state.memberOf.map((id) => organizations[id as keyof typeof organizations]),
  };
});

const { getCurrentUser, getOrganizationScope, requirePageUser, requireUser } =
  await import("./session");

describe("getCurrentUser", () => {
  beforeEach(() => {
    state.cookie = undefined;
    state.memberOf = [ALPHA, BETA];
    state.lastPicked = ALPHA;
  });

  it("uses the organization this browser picked over the one last picked elsewhere", async () => {
    state.cookie = BETA;
    expect(await getCurrentUser()).toMatchObject({
      organization: { id: BETA, name: "Beta" },
      role: "member",
    });
  });

  it("falls back to the last picked organization without a usable cookie", async () => {
    for (const cookie of [undefined, "", "not-a-uuid"]) {
      state.cookie = cookie;
      expect(await getCurrentUser(), String(cookie)).toMatchObject({
        organization: { id: ALPHA },
        role: "admin",
      });
    }
  });

  it("ignores a picked organization the user has since left", async () => {
    state.cookie = BETA;
    state.memberOf = [ALPHA];
    expect(await getCurrentUser()).toMatchObject({ organization: { id: ALPHA }, role: "admin" });

    state.memberOf = [];
    expect(await getCurrentUser()).toMatchObject({ organization: null, role: null });
  });
});

describe("getOrganizationScope", () => {
  beforeEach(() => {
    state.cookie = BETA;
    state.scopeCookie = undefined;
    state.memberOf = [ALPHA, BETA];
    state.lastPicked = ALPHA;
  });

  it("is every organization under the all scope with two or more memberships", async () => {
    state.scopeCookie = "all";
    expect(await getOrganizationScope()).toEqual({
      kind: "all",
      organizations: [organizations[ALPHA], organizations[BETA]],
    });
  });

  it("is the active organization without the scope cookie, or with another value", async () => {
    for (const scope of [undefined, "", "single", "ALL"]) {
      state.scopeCookie = scope;
      expect(await getOrganizationScope(), String(scope)).toEqual({
        kind: "single",
        organization: organizations[BETA],
      });
    }
  });

  it("falls back to the active organization once only one membership is left", async () => {
    state.scopeCookie = "all";
    state.memberOf = [ALPHA];
    expect(await getOrganizationScope()).toEqual({
      kind: "single",
      organization: organizations[ALPHA],
    });
  });

  it("leaves pages, actions and /api/ui on the single active organization under all", async () => {
    state.scopeCookie = "all";
    expect(await requirePageUser()).toMatchObject({
      organization: { id: BETA, name: "Beta" },
      role: "member",
    });
    expect(await requireUser()).toMatchObject({ organization: { id: BETA }, role: "member" });
  });
});
