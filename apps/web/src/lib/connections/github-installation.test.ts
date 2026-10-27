import { describe, expect, it } from "vitest";
import { githubAccountType, githubInstallationUrl } from "./github-installation";

describe("githubAccountType", () => {
  it("keeps User and Organization, and nothing else", () => {
    expect(githubAccountType("User")).toBe("User");
    expect(githubAccountType("Organization")).toBe("Organization");
    expect(githubAccountType("Enterprise")).toBeNull();
    expect(githubAccountType(undefined)).toBeNull();
  });
});

describe("githubInstallationUrl", () => {
  const installation = { host: "github.com", account: "acme corp", installationId: "42" };

  it("opens an organization's installation under the organization", () => {
    expect(githubInstallationUrl({ ...installation, accountType: "Organization" })).toBe(
      "https://github.com/organizations/acme%20corp/settings/installations/42",
    );
  });

  it("opens a personal account's installation, and one whose account type isn't recorded, in its settings", () => {
    expect(githubInstallationUrl({ ...installation, accountType: "User" })).toBe(
      "https://github.com/settings/installations/42",
    );
    expect(githubInstallationUrl({ ...installation, accountType: null })).toBe(
      "https://github.com/settings/installations/42",
    );
  });

  it("uses the connection's host (GitHub Enterprise Server)", () => {
    expect(
      githubInstallationUrl({
        host: "github.example.com",
        account: "platform",
        accountType: "Organization",
        installationId: "7",
      }),
    ).toBe("https://github.example.com/organizations/platform/settings/installations/7");
  });
});
