import { describe, expect, it } from "vitest";
import { changeRequestWebUrl, fileWebUrl, repositoryWebUrl } from "./web-url";

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

describe("fileWebUrl", () => {
  it("links to a file and its lines on a branch", () => {
    const gh = "https://github.com/acme/web";
    expect(fileWebUrl("github", gh, "main", { path: "src/a b.ts" })).toBe(
      "https://github.com/acme/web/blob/main/src/a%20b.ts",
    );
    expect(fileWebUrl("github", gh, "release/1", { path: "a.ts", startLine: 3 })).toBe(
      "https://github.com/acme/web/blob/release/1/a.ts#L3",
    );
    expect(fileWebUrl("github", gh, "main", { path: "a.ts", startLine: 3, endLine: 9 })).toBe(
      "https://github.com/acme/web/blob/main/a.ts#L3-L9",
    );
    expect(
      fileWebUrl("gitlab", "https://gitlab.example.com/g/p", "main", {
        path: "a.ts",
        startLine: 3,
        endLine: 9,
      }),
    ).toBe("https://gitlab.example.com/g/p/-/blob/main/a.ts#L3-9");
  });
});
