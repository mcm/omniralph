import type { Repository } from "@omniralph/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthorizationError } from "@/lib/auth/roles";
import type { OrgUser } from "@/lib/auth/session";
import { ApiRouteError } from "./handler";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/auth/session", () => ({}));

const ACTIVE = "00000000-0000-4000-8000-00000000000a";
const OTHER_MEMBERSHIP = "00000000-0000-4000-8000-00000000000b";
const STRANGER = "00000000-0000-4000-8000-00000000000c";
const REPO_ACTIVE = "00000000-0000-4000-8000-000000000001";
const REPO_MEMBER = "00000000-0000-4000-8000-000000000002";
const REPO_STRANGER = "00000000-0000-4000-8000-000000000003";

const repositories = new Map<string, Partial<Repository>>([
  [REPO_ACTIVE, { id: REPO_ACTIVE, organizationId: ACTIVE }],
  [REPO_MEMBER, { id: REPO_MEMBER, organizationId: OTHER_MEMBERSHIP }],
  [REPO_STRANGER, { id: REPO_STRANGER, organizationId: STRANGER }],
]);

const db = vi.hoisted(() => ({
  getRepository: vi.fn(),
  getMemberOrganization: vi.fn(),
}));
vi.mock("@omniralph/db", () => ({
  getRepository: db.getRepository,
  getMemberOrganization: db.getMemberOrganization,
  getRunIndexEntry: vi.fn(),
  listOrganizationsForUser: vi.fn(),
}));

const { requireRepositoryAccess } = await import("./scope");

// An admin of the active organization and a member of another one.
const user: OrgUser = {
  id: "user-1",
  organization: { id: ACTIVE, name: "Acme" },
  role: "admin",
  name: null,
  email: null,
  image: null,
  theme: null,
  showAdvanced: false,
};

beforeEach(() => {
  db.getRepository.mockImplementation(
    async (_db: unknown, id: string) => repositories.get(id) ?? null,
  );
  db.getMemberOrganization.mockImplementation(
    async (_db: unknown, { organizationId }: { organizationId: string }) =>
      organizationId === OTHER_MEMBERSHIP
        ? { id: OTHER_MEMBERSHIP, name: "Globex", role: "member" }
        : null,
  );
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => expect.unreachable("expected a rejection"),
    (error: unknown) => error,
  );
}

describe("requireRepositoryAccess", () => {
  it("answers the repo with its organization and the user's role there", async () => {
    expect(await requireRepositoryAccess(user, REPO_ACTIVE, "admin")).toEqual({
      repository: repositories.get(REPO_ACTIVE),
      organization: { id: ACTIVE, name: "Acme", role: "admin" },
    });
    // A repo of another of the user's organizations, without switching to it.
    expect(await requireRepositoryAccess(user, REPO_MEMBER, "member")).toEqual({
      repository: repositories.get(REPO_MEMBER),
      organization: { id: OTHER_MEMBERSHIP, name: "Globex", role: "member" },
    });
  });

  it("answers 404 for a repo outside the user's memberships, a missing one or a bad ID", async () => {
    for (const id of [REPO_STRANGER, "00000000-0000-4000-8000-000000000099", "not-a-uuid"]) {
      const error = await rejection(requireRepositoryAccess(user, id, "member"));
      expect(error).toBeInstanceOf(ApiRouteError);
      expect(error).toMatchObject({ status: 404 });
    }
  });

  it("answers 403 when admin access is asked of a member there", async () => {
    const error = await rejection(requireRepositoryAccess(user, REPO_MEMBER, "admin"));
    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error).toMatchObject({ reason: "forbidden" });
  });
});
