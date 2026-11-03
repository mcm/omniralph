import { describe, expect, it } from "vitest";
import { changeRequestNumberFromUrl } from "./change-request-url.js";

describe("changeRequestNumberFromUrl", () => {
  it("reads a GitHub pull request's number", () => {
    expect(changeRequestNumberFromUrl("https://github.com/acme/api/pull/42")).toBe(42);
    expect(changeRequestNumberFromUrl("https://github.example.com/acme/api/pull/7/")).toBe(7);
  });

  it("reads a GitLab merge request's number, nested groups included", () => {
    expect(
      changeRequestNumberFromUrl("https://gitlab.example.com/group/sub/api/-/merge_requests/13"),
    ).toBe(13);
  });

  it("returns null for URLs that aren't a pull or merge request", () => {
    expect(changeRequestNumberFromUrl(null)).toBeNull();
    expect(changeRequestNumberFromUrl("")).toBeNull();
    expect(changeRequestNumberFromUrl("not a url")).toBeNull();
    expect(changeRequestNumberFromUrl("https://github.com/acme/api")).toBeNull();
    expect(changeRequestNumberFromUrl("https://github.com/acme/api/pull/42/files")).toBeNull();
    expect(changeRequestNumberFromUrl("https://github.com/acme/api/pull/0")).toBeNull();
  });
});
