// Tests scripts/rewrite-legacy-changesets.ts, which publish-agent.yml runs before
// `pnpm changeset version` to release @omniralph/harness changesets as @omniralph/agent.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  rewriteLegacyChangeset,
  rewriteLegacyChangesets,
} from "../../../../scripts/rewrite-legacy-changesets.js";

const BODY = '\nFix the "@omniralph/harness": patch thing in @omniralph/harness.\n';

describe("rewriteLegacyChangeset", () => {
  it("renames a single legacy key and leaves the body unchanged", () => {
    expect(rewriteLegacyChangeset(`---\n"@omniralph/harness": patch\n---\n${BODY}`)).toBe(
      `---\n"@omniralph/agent": patch\n---\n${BODY}`,
    );
  });

  it("renames a single-quoted or unquoted key", () => {
    expect(rewriteLegacyChangeset("---\n'@omniralph/harness': minor\n---\n\nX\n")).toBe(
      '---\n"@omniralph/agent": minor\n---\n\nX\n',
    );
    expect(rewriteLegacyChangeset("---\n@omniralph/harness: minor\n---\n\nX\n")).toBe(
      '---\n"@omniralph/agent": minor\n---\n\nX\n',
    );
  });

  it("keeps one key with the larger bump when both names are there", () => {
    expect(
      rewriteLegacyChangeset(
        '---\n"@omniralph/agent": patch\n"@omniralph/web": patch\n"@omniralph/harness": minor\n---\n\nX\n',
      ),
    ).toBe('---\n"@omniralph/agent": minor\n"@omniralph/web": patch\n---\n\nX\n');
    expect(
      rewriteLegacyChangeset(
        '---\n"@omniralph/harness": major\n"@omniralph/agent": minor\n---\n\nX\n',
      ),
    ).toBe('---\n"@omniralph/agent": major\n---\n\nX\n');
  });

  it("keeps CRLF line endings", () => {
    expect(rewriteLegacyChangeset('---\r\n"@omniralph/harness": patch\r\n---\r\n\r\nX\r\n')).toBe(
      '---\r\n"@omniralph/agent": patch\r\n---\r\n\r\nX\r\n',
    );
  });

  it("leaves an already-rewritten changeset alone", () => {
    const rewritten = rewriteLegacyChangeset(`---\n"@omniralph/harness": patch\n---\n${BODY}`)!;
    expect(rewriteLegacyChangeset(rewritten)).toBeUndefined();
    expect(rewriteLegacyChangeset('---\n"@omniralph/agent": patch\n---\n\nX\n')).toBeUndefined();
  });

  it("leaves an empty changeset alone, even if its body names the old package", () => {
    expect(rewriteLegacyChangeset("---\n---\n")).toBeUndefined();
    expect(rewriteLegacyChangeset('---\n---\n\n"@omniralph/harness": patch\n')).toBeUndefined();
  });

  it("leaves a file without front matter alone", () => {
    expect(rewriteLegacyChangeset('# Notes\n\n"@omniralph/harness": patch\n')).toBeUndefined();
  });
});

describe("rewriteLegacyChangesets", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("rewrites the pending changesets, lists what it changed and is idempotent", () => {
    dir = mkdtempSync(path.join(tmpdir(), "rewrite-legacy-changesets-"));
    const files: Record<string, string> = {
      "b-legacy.md": `---\n"@omniralph/harness": patch\n---\n${BODY}`,
      "a-both.md": '---\n"@omniralph/agent": patch\n"@omniralph/harness": minor\n---\n\nA\n',
      "c-agent.md": '---\n"@omniralph/agent": patch\n---\n\nC\n',
      "d-empty.md": "---\n---\n",
      "README.md": '# Changesets\n\n"@omniralph/harness": patch\n',
      "config.json": '{"@omniralph/harness": "patch"}\n',
    };
    for (const [name, content] of Object.entries(files))
      writeFileSync(path.join(dir, name), content);
    mkdirSync(path.join(dir, "nested"));
    writeFileSync(path.join(dir, "nested", "x.md"), '---\n"@omniralph/harness": patch\n---\n');
    const read = (name: string) => readFileSync(path.join(dir!, name), "utf8");

    expect(rewriteLegacyChangesets(dir)).toEqual([
      ".changeset/a-both.md",
      ".changeset/b-legacy.md",
    ]);
    expect(read("a-both.md")).toBe('---\n"@omniralph/agent": minor\n---\n\nA\n');
    expect(read("b-legacy.md")).toBe(`---\n"@omniralph/agent": patch\n---\n${BODY}`);
    for (const name of ["c-agent.md", "d-empty.md", "README.md", "config.json"]) {
      expect(read(name)).toBe(files[name]);
    }

    expect(rewriteLegacyChangesets(dir)).toEqual([]);
    expect(read("a-both.md")).toBe('---\n"@omniralph/agent": minor\n---\n\nA\n');
  });
});
