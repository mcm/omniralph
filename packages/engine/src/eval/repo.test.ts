import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { loadCase, loadCases } from "./case.js";
import { buildCaseRepo, caseIdFromRepoDir } from "./repo.js";

const FIXTURES = fileURLToPath(new URL("../../test/fixtures/eval-cases", import.meta.url));

const gitIn = (dir: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

const scratch = mkdtempSync(join(tmpdir(), "omniralph-eval-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("buildCaseRepo", { timeout: 30_000 }, () => {
  it("commits base/ and then base + change.patch as the head", async () => {
    const evalCase = await loadCase(join(FIXTURES, "sql-bad"), "sql-bad");
    const repo = await buildCaseRepo(evalCase);
    try {
      expect(repo.baseSha).toMatch(/^[0-9a-f]{40}$/);
      expect(repo.headSha).not.toBe(repo.baseSha);
      expect(gitIn(repo.dir, "rev-parse", `${repo.headSha}^`)).toBe(repo.baseSha);
      expect(gitIn(repo.dir, "rev-parse", "HEAD")).toBe(repo.headSha);
      expect(gitIn(repo.dir, "status", "--porcelain")).toBe("");

      expect(gitIn(repo.dir, "ls-tree", "-r", "--name-only", repo.baseSha)).toBe("src/users.ts");
      expect(gitIn(repo.dir, "ls-tree", "-r", "--name-only", repo.headSha).split("\n")).toEqual([
        "src/db.ts",
        "src/users.ts",
      ]);
      expect(gitIn(repo.dir, "show", `${repo.headSha}:src/users.ts`)).toContain(
        `WHERE name = '" + name + "'`,
      );
      expect(gitIn(repo.dir, "show", `${repo.baseSha}:src/users.ts`)).not.toContain(
        "findUserByName",
      );
      expect(caseIdFromRepoDir(repo.dir)).toBe("sql-bad");
    } finally {
      await repo.cleanup();
    }
    expect(existsSync(repo.dir)).toBe(false);
  });

  it("produces the same SHAs every time", async () => {
    const evalCase = await loadCase(join(FIXTURES, "sql-clean"), "sql-clean");
    const a = await buildCaseRepo(evalCase);
    const b = await buildCaseRepo(evalCase);
    try {
      expect(a.dir).not.toBe(b.dir);
      expect([a.baseSha, a.headSha]).toEqual([b.baseSha, b.headSha]);
    } finally {
      await Promise.all([a.cleanup(), b.cleanup()]);
    }
  });

  it("fails and removes the temp repo when the patch doesn't apply", async () => {
    const dir = join(scratch, "broken");
    mkdirSync(join(dir, "base"), { recursive: true });
    writeFileSync(join(dir, "base", "a.txt"), "one\n");
    writeFileSync(
      join(dir, "change.patch"),
      "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-two\n+three\n",
    );
    const tmpRoot = join(scratch, "tmp");
    mkdirSync(tmpRoot);
    await expect(buildCaseRepo({ id: "broken", dir }, { tmpRoot })).rejects.toThrow(/git apply/);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });
});

describe("loadCases", () => {
  it("loads every case directory, sorted, and filters by ID", async () => {
    expect((await loadCases(FIXTURES)).map((c) => c.id)).toEqual(["sql-bad", "sql-clean"]);
    const [only] = await loadCases(FIXTURES, ["sql-clean"]);
    expect(only).toMatchObject({ id: "sql-clean", expected: [], dir: join(FIXTURES, "sql-clean") });
    await expect(loadCases(FIXTURES, ["nope"])).rejects.toThrow("Unknown case: nope");
  });

  it("rejects an invalid case.json", async () => {
    const dir = join(scratch, "invalid");
    mkdirSync(join(dir, "base"), { recursive: true });
    writeFileSync(join(dir, "change.patch"), "");
    writeFileSync(
      join(dir, "case.json"),
      JSON.stringify({
        description: "x",
        language: "typescript",
        tags: [],
        pr: { title: "x" },
        expected: [
          { path: "a.ts", startLine: 1, endLine: 1, category: "style", minSeverity: "high" },
        ],
      }),
    );
    await expect(loadCase(dir, "invalid")).rejects.toThrow(/invalid case\.json/);
  });

  it("parses case IDs only from case repo directories", () => {
    expect(caseIdFromRepoDir("/tmp/omniralph-eval-bad-sql-concat-a1B2c3")).toBe("bad-sql-concat");
    expect(caseIdFromRepoDir("/tmp/other-bad-sql-concat-a1B2c3")).toBeUndefined();
  });
});
