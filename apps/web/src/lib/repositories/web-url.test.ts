import { describe, expect, it } from "vitest";
import { repositoryWebUrl } from "./web-url";

describe("repositoryWebUrl", () => {
  it("maps API URLs to browser URLs", () => {
    expect(repositoryWebUrl("github", "https://api.github.com", "acme/web")).toBe(
      "https://github.com/acme/web",
    );
    expect(repositoryWebUrl("github", "https://ghe.example.com/api/v3/", "acme/web")).toBe(
      "https://ghe.example.com/acme/web",
    );
    expect(repositoryWebUrl("gitlab", "https://gitlab.example.com", "g/sub/p")).toBe(
      "https://gitlab.example.com/g/sub/p",
    );
  });
});
