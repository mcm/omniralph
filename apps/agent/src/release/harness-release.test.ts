// Tests scripts/harness-release.ts, the helpers .github/workflows/publish-agent.yml uses to
// decide whether to publish and to build the GitHub Release notes.
import { describe, expect, it } from "vitest";
import {
  changelogSection,
  isPublished,
  pendingReleaseChangesets,
  releaseTag,
} from "../../../../scripts/harness-release.js";

const CHANGELOG = `# @omniralph/agent

## 0.15.0

### Minor Changes

- [#12](https://github.com/mcm/omniralph/pull/12) [\`abc1234\`](https://github.com/mcm/omniralph/commit/abc1234) Thanks [@someone](https://github.com/someone)! - Add a thing

### Patch Changes

- Fix a thing

## 0.14.0

### Minor Changes

- Older change
`;

describe("releaseTag", () => {
  it("keeps the agent-v<version> convention", () => {
    expect(releaseTag("0.14.0")).toBe("agent-v0.14.0");
  });
});

describe("changelogSection", () => {
  it("returns one version's section without its heading", () => {
    expect(changelogSection(CHANGELOG, "0.15.0")).toBe(
      [
        "### Minor Changes",
        "",
        "- [#12](https://github.com/mcm/omniralph/pull/12) [`abc1234`](https://github.com/mcm/omniralph/commit/abc1234) Thanks [@someone](https://github.com/someone)! - Add a thing",
        "",
        "### Patch Changes",
        "",
        "- Fix a thing",
      ].join("\n"),
    );
  });

  it("returns the last section up to the end of the file", () => {
    expect(changelogSection(CHANGELOG, "0.14.0")).toBe("### Minor Changes\n\n- Older change");
  });

  it("matches the exact version", () => {
    expect(changelogSection(CHANGELOG, "0.15")).toBeUndefined();
    expect(changelogSection(CHANGELOG, "0.13.1")).toBeUndefined();
  });

  it("handles CRLF line endings", () => {
    expect(changelogSection("# x\r\n\r\n## 1.0.0\r\n\r\n- One\r\n", "1.0.0")).toBe("- One");
  });
});

describe("isPublished", () => {
  it("is true when npm prints the version", () => {
    expect(isPublished({ status: 0, stdout: '"0.13.1"\n', stderr: "" }, "0.13.1")).toBe(true);
  });

  it("is false for E404 (unknown version or package)", () => {
    const stderr = "npm error code E404\nnpm error 404 No match found for version 0.14.0\n";
    expect(isPublished({ status: 1, stdout: '{"error":{}}', stderr }, "0.14.0")).toBe(false);
  });

  it("is false when npm prints nothing", () => {
    expect(isPublished({ status: 0, stdout: "", stderr: "" }, "0.14.0")).toBe(false);
  });

  it("reads an array of versions", () => {
    expect(isPublished({ status: 0, stdout: '["0.14.0","0.14.1"]', stderr: "" }, "0.14.1")).toBe(
      true,
    );
  });

  it("throws on other npm failures rather than publishing", () => {
    expect(() =>
      isPublished({ status: 1, stdout: "", stderr: "npm error code ETIMEDOUT\n" }, "0.14.0"),
    ).toThrow(/ETIMEDOUT/);
  });
});

describe("pendingReleaseChangesets", () => {
  it("lists changesets that release a package, not empty ones", () => {
    expect(
      pendingReleaseChangesets([
        { path: ".changeset/a.md", content: '---\n"@omniralph/agent": minor\n---\n\nA\n' },
        { path: ".changeset/b.md", content: "---\n---\n" },
        { path: ".changeset/c.md", content: "no front matter\n" },
      ]),
    ).toEqual([".changeset/a.md"]);
  });
});
