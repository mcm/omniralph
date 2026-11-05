import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/components/current-user";

const session = vi.hoisted(() => ({
  requirePageUser: vi.fn(),
  getOrganizationMemberships: vi.fn(),
  getOrganizationScope: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => session);
const db = vi.hoisted(() => ({ listPendingInvitationsForEmail: vi.fn() }));
vi.mock("@omniralph/db", () => db);
const handle = vi.hoisted(() => ({}));
vi.mock("@/lib/db", () => ({ getDb: () => handle }));
vi.mock("@/components/app-shell", () => ({ AppShell: () => null }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

const { default: AppLayout } = await import("./layout");

const ORG = { id: "11111111-1111-4111-8111-111111111111", name: "Acme" };

function signedIn(email: string | null) {
  session.requirePageUser.mockResolvedValue({
    id: "user-1",
    organization: ORG,
    role: "member",
    name: "Ada",
    email,
    image: null,
    theme: "system",
    showAdvanced: false,
    sound: false,
  });
}

beforeEach(() => {
  session.requirePageUser.mockReset();
  session.getOrganizationMemberships.mockReset().mockResolvedValue([{ ...ORG, role: "member" }]);
  session.getOrganizationScope.mockReset().mockResolvedValue({ kind: "single" });
  db.listPendingInvitationsForEmail.mockReset();
});

async function shellUser(): Promise<SessionUser> {
  const shell = (await AppLayout({ children: null })) as ReactElement<{ user: SessionUser }>;
  return shell.props.user;
}

describe("the signed-in layout", () => {
  it("gives the shell the number of the user's pending invitations", async () => {
    signedIn("ada@example.com");
    db.listPendingInvitationsForEmail.mockResolvedValue([{ id: "i-1" }, { id: "i-2" }]);
    expect((await shellUser()).pendingInvitations).toBe(2);
    expect(db.listPendingInvitationsForEmail).toHaveBeenCalledWith(handle, "ada@example.com");
  });

  it("gives zero when none are pending", async () => {
    signedIn("ada@example.com");
    db.listPendingInvitationsForEmail.mockResolvedValue([]);
    expect((await shellUser()).pendingInvitations).toBe(0);
  });

  it("does not look for invitations when the user has no email", async () => {
    signedIn(null);
    expect((await shellUser()).pendingInvitations).toBe(0);
    expect(db.listPendingInvitationsForEmail).not.toHaveBeenCalled();
  });
});
