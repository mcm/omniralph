import { describe, expect, it } from "vitest";
import { linearSiblingIssueUrl } from "./urls.js";

describe("linearSiblingIssueUrl", () => {
  it("links another issue of the same workspace", () => {
    expect(linearSiblingIssueUrl("https://linear.app/acme/issue/ENG-1/epic-title", "OPS-2")).toBe(
      "https://linear.app/acme/issue/OPS-2",
    );
  });

  it("is null for a URL that isn't a Linear issue's", () => {
    expect(linearSiblingIssueUrl("https://example.com/ENG-1", "OPS-2")).toBeNull();
    expect(linearSiblingIssueUrl("https://linear.app/acme/project/x", "OPS-2")).toBeNull();
  });
});
