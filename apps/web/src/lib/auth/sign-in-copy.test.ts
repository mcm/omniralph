import { describe, expect, it } from "vitest";
import { signInDescription } from "./sign-in-copy";

describe("signInDescription", () => {
  it("names only the providers that are configured", () => {
    expect(signInDescription(["GitHub"], false)).toBe(
      "Use your GitHub account. Access is limited to approved team members.",
    );
    expect(signInDescription(["GitHub", "GitLab"], true)).toBe(
      "Use your GitHub or GitLab account. Access is limited to approved team members.",
    );
  });

  it("describes the dev sign-in when it is the only way in", () => {
    const text = signInDescription([], true);
    expect(text).not.toMatch(/GitHub|GitLab/);
    expect(text).toContain("development only");
  });

  it("says when there is no way to sign in", () => {
    expect(signInDescription([], false)).toBe("No sign-in method is set up on this server yet.");
  });
});
