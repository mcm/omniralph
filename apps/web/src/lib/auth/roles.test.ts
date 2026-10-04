import { describe, expect, it } from "vitest";
import { assertRole, AuthorizationError, checkUserChange, hasRole, isRole } from "./roles";

const admin = { id: "a", role: "admin" as const };
const member = { id: "m", role: "member" as const };

describe("hasRole", () => {
  it("lets admins do everything", () => {
    expect(hasRole(admin, "admin")).toBe(true);
    expect(hasRole(admin, "member")).toBe(true);
  });

  it("limits members to member access", () => {
    expect(hasRole(member, "member")).toBe(true);
    expect(hasRole(member, "admin")).toBe(false);
  });

  it("denies a missing user", () => {
    expect(hasRole(null, "member")).toBe(false);
    expect(hasRole(undefined, "admin")).toBe(false);
  });
});

describe("assertRole", () => {
  it("returns the user when the role is sufficient", () => {
    expect(assertRole(admin, "admin")).toBe(admin);
    expect(assertRole(member, "member")).toBe(member);
  });

  it("throws unauthenticated without a user", () => {
    expect(() => assertRole(null, "member")).toThrow(
      expect.objectContaining({ name: "AuthorizationError", reason: "unauthenticated" }),
    );
  });

  it("throws forbidden when a member needs admin", () => {
    let error: unknown;
    try {
      assertRole(member, "admin");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AuthorizationError);
    expect(error).toMatchObject({
      reason: "forbidden",
      message: "This action requires the admin role.",
    });
  });
});

describe("isRole", () => {
  it("accepts only known roles", () => {
    expect(isRole("admin")).toBe(true);
    expect(isRole("member")).toBe(true);
    expect(isRole("owner")).toBe(false);
    expect(isRole(undefined)).toBe(false);
  });
});

describe("checkUserChange", () => {
  it("allows promoting and demoting when another admin remains", () => {
    expect(
      checkUserChange({ actorId: "a", target: member, newRole: "admin", adminCount: 1 }),
    ).toBeNull();
    expect(
      checkUserChange({
        actorId: "a",
        target: { id: "b", role: "admin" },
        newRole: "member",
        adminCount: 2,
      }),
    ).toBeNull();
    expect(
      checkUserChange({ actorId: "a", target: admin, newRole: "member", adminCount: 2 }),
    ).toBeNull();
  });

  it("never leaves the panel without an admin", () => {
    expect(checkUserChange({ actorId: "a", target: admin, newRole: "member", adminCount: 1 })).toBe(
      "There must be at least one admin.",
    );
    expect(checkUserChange({ actorId: "x", target: admin, newRole: null, adminCount: 1 })).toBe(
      "There must be at least one admin.",
    );
  });

  it("stops admins from removing themselves", () => {
    expect(checkUserChange({ actorId: "a", target: admin, newRole: null, adminCount: 3 })).toBe(
      "You can't remove yourself.",
    );
  });

  it("allows removing other users", () => {
    expect(
      checkUserChange({ actorId: "a", target: member, newRole: null, adminCount: 1 }),
    ).toBeNull();
  });
});
