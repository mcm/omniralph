import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { createEnterOrganizationPath, readEnterOrganizationToken, ENTER_ORGANIZATION_TTL_SECONDS } =
  await import("./enter");
const { createSignedState } = await import("@/lib/auth/signed-state");

const env = { AUTH_SECRET: "test-auth-secret" } as unknown as NodeJS.ProcessEnv;
const input = { userId: "user-1", organizationId: "org-1", next: "/ralph/run-1?tab=log" };
const tokenOf = (path: string) => new URL(path, "http://localhost").searchParams.get("token");

describe("enter organization token", () => {
  it("reads back the organization and next path for the same user only", async () => {
    const path = await createEnterOrganizationPath(input, env);
    expect(path).toMatch(/^\/api\/organizations\/enter\?token=[^&]+$/);
    const token = tokenOf(path);
    expect(await readEnterOrganizationToken(token, "user-1", env)).toEqual({
      organizationId: "org-1",
      next: "/ralph/run-1?tab=log",
    });
    expect(await readEnterOrganizationToken(token, "user-2", env)).toBeNull();
  });

  it("refuses missing, expired, foreign-key and other-purpose tokens", async () => {
    const now = new Date("2026-10-09T00:00:00Z");
    const token = tokenOf(await createEnterOrganizationPath(input, env, now));
    expect(await readEnterOrganizationToken(null, "user-1", env, now)).toBeNull();
    expect(await readEnterOrganizationToken("", "user-1", env, now)).toBeNull();
    const later = new Date(now.getTime() + (ENTER_ORGANIZATION_TTL_SECONDS + 1) * 1000);
    expect(await readEnterOrganizationToken(token, "user-1", env, later)).toBeNull();
    const otherEnv = { AUTH_SECRET: "other-secret" } as unknown as NodeJS.ProcessEnv;
    expect(await readEnterOrganizationToken(token, "user-1", otherEnv, now)).toBeNull();
    // Another flow's signed state isn't an enter token.
    const { state } = await createSignedState("linear-oauth", input, env);
    expect(await readEnterOrganizationToken(state, "user-1", env)).toBeNull();
  });
});
