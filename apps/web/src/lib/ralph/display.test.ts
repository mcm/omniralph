import { describe, expect, it } from "vitest";
import {
  linearIssueUrl,
  parseRalphRunListParams,
  ralphRunListHref,
  shortSha,
  truncate,
} from "./display";

const REPO = "0b7c2a7e-6f43-4c0a-9a43-2f1c3e0d5a11";

describe("ralph run list params", () => {
  it("parses status, repository and page; ignores unknown values", () => {
    expect(parseRalphRunListParams({ status: "waiting", repository: REPO, page: "2" })).toEqual({
      status: "waiting",
      repositoryId: REPO,
      page: 2,
    });
    expect(parseRalphRunListParams({ status: "nope", repository: "x", page: "-1" })).toEqual({
      status: null,
      repositoryId: null,
      page: 1,
    });
    expect(parseRalphRunListParams({ status: ["failed", "waiting"] }).status).toBe("failed");
  });

  it("builds list URLs without defaults", () => {
    expect(ralphRunListHref("/ralph", { status: null, repositoryId: null, page: 1 })).toBe(
      "/ralph",
    );
    expect(ralphRunListHref("/ralph", { status: "running", repositoryId: REPO, page: 3 })).toBe(
      `/ralph?status=running&repository=${REPO}&page=3`,
    );
  });
});

describe("formatting", () => {
  it("derives other issues' Linear URLs from the run's", () => {
    expect(linearIssueUrl("https://linear.app/acme/issue/ENG-1/epic-title", "OPS-2")).toBe(
      "https://linear.app/acme/issue/OPS-2",
    );
    expect(linearIssueUrl(null, "OPS-2")).toBeNull();
    expect(linearIssueUrl("https://example.com/ENG-1", "OPS-2")).toBeNull();
  });

  it("shortens SHAs and truncates text", () => {
    expect(shortSha("a".repeat(40))).toBe("a".repeat(12));
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("0123456789abc", 10)).toBe("012345678…");
  });
});
