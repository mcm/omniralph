import { describe, expect, it, vi } from "vitest";
import { emailDomain, isEmailAllowed, isValidEmail, parseAllowedDomains } from "./allowlist";

describe("parseAllowedDomains", () => {
  it("splits on commas and whitespace, lower-cases, strips @ and dedupes", () => {
    expect(parseAllowedDomains(" McMaster.io, @example.com  example.com,,")).toEqual([
      "mcmaster.io",
      "example.com",
    ]);
  });

  it("returns nothing when unset or blank", () => {
    expect(parseAllowedDomains(undefined)).toEqual([]);
    expect(parseAllowedDomains("  ")).toEqual([]);
  });
});

describe("emailDomain", () => {
  it("returns the lower-cased domain", () => {
    expect(emailDomain("Steve@McMaster.IO")).toBe("mcmaster.io");
    expect(emailDomain("odd@name@corp.com")).toBe("corp.com");
  });

  it("rejects malformed addresses", () => {
    expect(emailDomain("nope")).toBeNull();
    expect(emailDomain("@corp.com")).toBeNull();
    expect(emailDomain("me@")).toBeNull();
  });
});

describe("isValidEmail", () => {
  it("checks the basic shape", () => {
    expect(isValidEmail("a@b.co")).toBe(true);
    expect(isValidEmail(" a@b.co ")).toBe(true);
    expect(isValidEmail("a@b")).toBe(false);
    expect(isValidEmail("a b@c.io")).toBe(false);
  });
});

describe("isEmailAllowed", () => {
  const allowedDomains = ["mcmaster.io"];

  it("allows emails in an allowed domain without consulting the allowlist", async () => {
    const isAllowlisted = vi.fn(() => false);
    await expect(
      isEmailAllowed({ email: "Steve@McMaster.io", allowedDomains, isAllowlisted }),
    ).resolves.toBe(true);
    expect(isAllowlisted).not.toHaveBeenCalled();
  });

  it("does not treat subdomains or look-alike domains as allowed", async () => {
    const isAllowlisted = () => false;
    for (const email of ["a@evil.mcmaster.io", "a@mcmaster.io.evil.com", "a@notmcmaster.io"]) {
      await expect(isEmailAllowed({ email, allowedDomains, isAllowlisted })).resolves.toBe(false);
    }
  });

  it("allows emails an admin pre-added, passing them lower-cased", async () => {
    const isAllowlisted = vi.fn(async (email: string) => email === "guest@example.com");
    await expect(
      isEmailAllowed({ email: "Guest@Example.com", allowedDomains, isAllowlisted }),
    ).resolves.toBe(true);
    expect(isAllowlisted).toHaveBeenCalledWith("guest@example.com");
    await expect(
      isEmailAllowed({ email: "other@example.com", allowedDomains, isAllowlisted }),
    ).resolves.toBe(false);
  });

  it("works with only the allowlist (no domains)", async () => {
    await expect(
      isEmailAllowed({ email: "a@b.io", allowedDomains: [], isAllowlisted: () => true }),
    ).resolves.toBe(true);
    await expect(
      isEmailAllowed({ email: "a@b.io", allowedDomains: [], isAllowlisted: () => false }),
    ).resolves.toBe(false);
  });

  it("denies accounts without a usable email", async () => {
    const isAllowlisted = () => true;
    for (const email of [null, undefined, "", "not-an-email"]) {
      await expect(isEmailAllowed({ email, allowedDomains, isAllowlisted })).resolves.toBe(false);
    }
  });
});
