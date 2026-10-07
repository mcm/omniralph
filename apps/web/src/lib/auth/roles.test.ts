import { describe, expect, it } from "vitest";
import {
  assertOrgRole,
  assertRole,
  AuthorizationError,
  checkUserChange,
  hasRole,
  isRole,
} from "./roles";

const admin = { id: "a", role: "admin" as const, organization: { id: "org-1" } };
const member = { id: "m", role: "member" as const, organization: { id: "org-1" } };
const noOrg = { id: "n", role: null, organization: null };

describe("hasRole", () => {
  it("lets admins do everything", () => {
    expect(hasRole(admin, "admin")).toBe(true);
    expect(hasRole(admin, "member")).toBe(true);
  });

  it("limits members to member access", () => {
    expect(hasRole(member, "member")).toBe(true);
    expect(hasRole(member, "admin")).toBe(false);
  });

  it("denies users without an active organization", () => {
    expect(hasRole(noOrg, "member")).toBe(false);
    expect(hasRole(noOrg, "admin")).toBe(false);
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

describe("assertRole without an organization", () => {
  it("asks the user to create or join an organization", () => {
    expect(() => assertRole(noOrg, "member")).toThrow(
      expect.objectContaining({
        reason: "forbidden",
        message: "Create or join an organization first.",
      }),
    );
  });
});

describe("assertOrgRole", () => {
  it("checks the role in the given organization only", () => {
    expect(assertOrgRole(admin, "org-1", "admin")).toBe(admin);
    expect(assertOrgRole(member, "org-1", "member")).toBe(member);
    expect(() => assertOrgRole(member, "org-1", "admin")).toThrow(
      expect.objectContaining({ reason: "forbidden" }),
    );
  });

  it("rejects an admin acting on another organization", () => {
    expect(() => assertOrgRole(admin, "org-2", "member")).toThrow(
      expect.objectContaining({
        reason: "forbidden",
        message: "You are not a member of this organization.",
      }),
    );
    expect(() => assertOrgRole(noOrg, "org-1", "member")).toThrow(AuthorizationError);
    expect(() => assertOrgRole(null, "org-1", "member")).toThrow(
      expect.objectContaining({ reason: "unauthenticated" }),
    );
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

  it("never leaves the organization without an admin", () => {
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
