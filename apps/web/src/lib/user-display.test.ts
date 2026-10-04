import { describe, expect, it } from "vitest";
import { userDisplayName, userInitials } from "./user-display";

describe("userInitials", () => {
  it("uses the first and last name", () => {
    expect(userInitials({ name: "Steve Q McMaster", email: null })).toBe("SM");
  });

  it("falls back to the email or a placeholder", () => {
    expect(userInitials({ name: null, email: "dev@x.io" })).toBe("DE");
    expect(userInitials({ name: "  ", email: null })).toBe("?");
  });
});

describe("userDisplayName", () => {
  it("prefers the name, then the email", () => {
    expect(userDisplayName({ name: "Ada", email: "a@x.io" })).toBe("Ada");
    expect(userDisplayName({ name: null, email: "a@x.io" })).toBe("a@x.io");
    expect(userDisplayName({ name: null, email: null })).toBe("Unknown user");
  });
});
