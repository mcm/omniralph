import { describe, expect, it } from "vitest";
import { matchSelection, type RoutableRepository } from "./routing";

const repo = (fullPath: string): RoutableRepository => ({ fullPath });

describe("matchSelection", () => {
  const api = repo("platform/api");
  const web = repo("group/platform/web");

  it("matches the option value, name, id, or number", () => {
    // The option text (the full path), ignoring case.
    expect(matchSelection("Platform/API", [api, web])).toBe(api);
    expect(matchSelection("group/platform/web", [api, web])).toBe(web);
    // A repository name: the last segment, or the path with a trailing slash or `.git`.
    expect(matchSelection("web", [api, web])).toBe(web);
    expect(matchSelection("platform/api.git", [api, web])).toBe(api);
    // A 1-based option number.
    expect(matchSelection("2", [api, web])).toBe(web);
    expect(matchSelection(" 1 ", [api, web])).toBe(api);
    // A reply that contains a repository's path.
    expect(matchSelection("the platform/api one please", [api, web])).toBe(api);
    expect(matchSelection("mobile", [api, web])).toBeUndefined();
    expect(matchSelection("3", [api, web])).toBeUndefined();
    expect(matchSelection("0", [api, web])).toBeUndefined();
  });

  it("matches a repository's URL, preferring the longest path it contains", () => {
    const nested = repo("group/platform/api");
    const v2 = repo("platform/api-v2");
    const all = [api, nested, v2, web];
    expect(matchSelection("https://github.com/group/platform/api", all)).toBe(nested);
    expect(matchSelection("https://gitlab.example.com/platform/api/", all)).toBe(api);
    expect(matchSelection("https://github.com/platform/api-v2.git", all)).toBe(v2);
    expect(matchSelection("https://github.com/group/platform/web", all)).toBe(web);
    expect(matchSelection("https://github.com/xplatform/api", [api])).toBeUndefined();
  });

  it("prefers a number over a repository named like one", () => {
    const numbered = repo("acme/2");
    expect(matchSelection("2", [numbered, api])).toBe(api);
    expect(matchSelection("acme/2", [numbered, api])).toBe(numbered);
  });
});
