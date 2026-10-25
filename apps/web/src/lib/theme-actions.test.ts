import { beforeEach, describe, expect, it, vi } from "vitest";

const setUserTheme = vi.fn(async () => {});
const recordChange = vi.fn();
const db = {};
const ORG = "11111111-1111-4111-8111-111111111111";
let organization: { id: string } | null = { id: ORG };

vi.mock("@omniralph/db", () => ({ setUserTheme }));
vi.mock("@omniralph/db/changes", () => ({ recordChange }));
vi.mock("@/lib/db", () => ({ getDb: () => db }));
vi.mock("@/lib/auth/admin-action", () => ({
  runSignedInAction: async (fn: (user: unknown) => Promise<unknown>) =>
    (await fn({ id: "user-1", organization })) ?? { ok: true },
}));

const { saveThemePreference } = await import("./theme-actions");

beforeEach(() => {
  setUserTheme.mockClear();
  recordChange.mockClear();
  organization = { id: ORG };
});

describe("saveThemePreference", () => {
  it.each([
    ["system", null],
    ["dark", "dark"],
    ["light", "light"],
  ] as const)("stores %s as %s", async (preference, stored) => {
    await expect(saveThemePreference(preference)).resolves.toEqual({ ok: true });
    expect(setUserTheme).toHaveBeenCalledTimes(1);
    expect(setUserTheme).toHaveBeenCalledWith(db, "user-1", stored);
  });

  it("tells the user's other devices on their own channel", async () => {
    await saveThemePreference("light");
    expect(recordChange).toHaveBeenCalledWith(db, {
      resource: "settings",
      section: "profile",
      ids: ["user-1"],
      organizationId: ORG,
      userId: "user-1",
    });
  });

  it("records no change for a user without an organization", async () => {
    organization = null;
    await expect(saveThemePreference("dark")).resolves.toEqual({ ok: true });
    expect(recordChange).not.toHaveBeenCalled();
  });

  it("rejects anything else without saving", async () => {
    // A server action can be called with any value from the client.
    const result = await saveThemePreference("sepia" as never);
    expect(result).toEqual({ ok: false, error: "Unknown theme." });
    expect(setUserTheme).not.toHaveBeenCalled();
  });
});
