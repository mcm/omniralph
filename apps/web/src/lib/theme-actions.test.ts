import { beforeEach, describe, expect, it, vi } from "vitest";

const setUserTheme = vi.fn(async () => {});
const db = {};

vi.mock("@omniralph/db", () => ({ setUserTheme }));
vi.mock("@/lib/db", () => ({ getDb: () => db }));
vi.mock("@/lib/auth/session", () => ({
  requireSignedInUser: vi.fn(async () => ({ id: "user-1" })),
}));

const { saveThemePreference } = await import("./theme-actions");

beforeEach(() => {
  setUserTheme.mockClear();
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

  it("rejects anything else without saving", async () => {
    // A server action can be called with any value from the client.
    const result = await saveThemePreference("sepia" as never);
    expect(result).toEqual({ ok: false, error: "Unknown theme." });
    expect(setUserTheme).not.toHaveBeenCalled();
  });
});
