// Tests scripts/agent-release.ts, the helpers .github/workflows/publish-agent.yml uses to
// decide whether to publish and to build the GitHub Release notes.
import { describe, expect, it } from "vitest";
import {
  changelogSection,
  isPublished,
  type NpmViewResult,
  pendingReleaseChangesets,
  releaseStatus,
  releaseTag,
} from "../../../../scripts/agent-release.js";

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
    expect(releaseTag("2.0.0")).toBe("agent-v2.0.0");
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

describe("releaseStatus", () => {
  const notOnNpm: NpmViewResult = { status: 0, stdout: "", stderr: "" };
  const onNpm = (version: string): NpmViewResult => ({
    status: 0,
    stdout: JSON.stringify(version),
    stderr: "",
  });
  const unexpected = (): NpmViewResult => {
    throw new Error("npm view should not run");
  };
  const major = { path: ".changeset/a.md", content: '---\n"@omniralph/agent": major\n---\n\nA\n' };

  it("holds the release back while changesets are pending, even at 1.0.0", () => {
    expect(releaseStatus({ version: "1.0.0", changesets: [major], npmView: unexpected })).toEqual({
      version: "1.0.0",
      tag: "agent-v1.0.0",
      publish: false,
      message:
        "Changesets are pending (.changeset/a.md): the Version Packages pull request releases them.",
    });
  });

  it("refuses to publish 1.0.0 or anything else below 2.0.0", () => {
    for (const version of ["1.0.0", "0.8.0", "0.13.2", "1.99.99"]) {
      expect(() => releaseStatus({ version, changesets: [], npmView: () => notOnNpm })).toThrow(
        `@omniralph/agent@${version} is below 2.0.0`,
      );
    }
  });

  it("publishes 2.0.0 when it isn't on npm yet", () => {
    const specs: string[] = [];
    const status = releaseStatus({
      version: "2.0.0",
      changesets: [{ path: ".changeset/b.md", content: "---\n---\n" }],
      npmView: (spec) => {
        specs.push(spec);
        return notOnNpm;
      },
    });
    expect(specs).toEqual(["@omniralph/agent@2.0.0"]);
    expect(status).toEqual({
      version: "2.0.0",
      tag: "agent-v2.0.0",
      publish: true,
      message: "@omniralph/agent@2.0.0 isn't on npm yet: releasing it as agent-v2.0.0.",
    });
  });

  it("does nothing for a version already on npm", () => {
    const status = releaseStatus({
      version: "2.1.0",
      changesets: [],
      npmView: () => onNpm("2.1.0"),
    });
    expect(status.publish).toBe(false);
    expect(status.message).toBe("@omniralph/agent@2.1.0 is already on npm: nothing to release.");
  });
});
