import { describe, expect, it } from "vitest";
import { changeRequestWebUrl, repositoryWebUrl } from "./web-url";

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

describe("changeRequestWebUrl", () => {
  it("links to the pull or merge request", () => {
    expect(changeRequestWebUrl("github", "https://api.github.com", "acme/web", 12)).toBe(
      "https://github.com/acme/web/pull/12",
    );
    expect(changeRequestWebUrl("gitlab", "https://gitlab.example.com", "g/p", 7)).toBe(
      "https://gitlab.example.com/g/p/-/merge_requests/7",
    );
  });
});
