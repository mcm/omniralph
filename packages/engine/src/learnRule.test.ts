import { MAX_LEARNED_RULE_LENGTH } from "@omniralph/shared";
import { describe, expect, it } from "vitest";
import { buildLearnRulePrompt, findingHunks, parseLearnedRuleOutput } from "./learnRule.js";

const DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 export { a };
@@ -20,2 +21,3 @@
 function f() {
+  return eval(input);
 }
diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index 3333333..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-const x = 1;
-export { x };
`;

describe("parseLearnedRuleOutput", () => {
  it("accepts a valid rule and collapses its whitespace", () => {
    expect(parseLearnedRuleOutput('{"rule": "Do not flag eval() in\\n  test fixtures."}')).toEqual({
      status: "rule",
      rule: "Do not flag eval() in test fixtures.",
    });
  });

  it("accepts a rule inside a json fence or surrounded by text", () => {
    expect(parseLearnedRuleOutput('```json\n{"rule": "Do not flag X."}\n```')).toEqual({
      status: "rule",
      rule: "Do not flag X.",
    });
    expect(parseLearnedRuleOutput('Here you go: {"rule": "Do not flag Y."} Done.')).toEqual({
      status: "rule",
      rule: "Do not flag Y.",
    });
  });

  it("returns none for null and for an empty rule", () => {
    expect(parseLearnedRuleOutput('{"rule": null}')).toEqual({ status: "none" });
    expect(parseLearnedRuleOutput('{"rule": "   "}')).toEqual({ status: "none" });
  });

  it("rejects a rule over the length limit", () => {
    const ok = "a".repeat(MAX_LEARNED_RULE_LENGTH);
    expect(parseLearnedRuleOutput(JSON.stringify({ rule: ok }))).toEqual({
      status: "rule",
      rule: ok,
    });
    const parsed = parseLearnedRuleOutput(JSON.stringify({ rule: `${ok}b` }));
    expect(parsed.status).toBe("rejected");
    expect(parsed).toMatchObject({ error: expect.stringContaining("301 characters") });
  });

  it("rejects answers that aren't the expected JSON", () => {
    for (const text of ["no idea", '{"rules": ["x"]}', '{"rule": 42}', '["x"]', ""]) {
      expect(parseLearnedRuleOutput(text).status, text).toBe("rejected");
    }
  });
});

describe("findingHunks", () => {
  it("returns the hunk that contains the finding's head lines", () => {
    expect(findingHunks(DIFF, { path: "src/app.ts", startLine: 22, endLine: 22 })).toBe(
      "@@ -20,2 +21,3 @@\n function f() {\n+  return eval(input);\n }",
    );
  });

  it("joins every overlapping hunk", () => {
    const hunks = findingHunks(DIFF, { path: "src/app.ts", startLine: 2, endLine: 22 });
    expect(hunks).toContain("@@ -1,3 +1,4 @@");
    expect(hunks).toContain("@@ -20,2 +21,3 @@");
  });

  it("uses base lines for deleted files", () => {
    expect(findingHunks(DIFF, { path: "src/old.ts", startLine: 1, endLine: 1 })).toContain(
      "-const x = 1;",
    );
  });

  it("returns null for another file or lines outside the diff", () => {
    expect(findingHunks(DIFF, { path: "src/none.ts", startLine: 1, endLine: 1 })).toBeNull();
    expect(findingHunks(DIFF, { path: "src/app.ts", startLine: 10, endLine: 12 })).toBeNull();
  });
});

describe("buildLearnRulePrompt", () => {
  const finding = {
    path: "src/app.ts",
    startLine: 22,
    endLine: 22,
    severity: "high",
    category: "security",
    title: "eval of user input",
    body: "`eval` runs arbitrary code.",
  };

  it("quotes the finding, the hunk and the note as data", () => {
    const prompt = buildLearnRulePrompt({
      finding,
      hunk: "@@ -20,2 +21,3 @@\n+  return eval(input);",
      note: "input is a constant from our build script",
    });
    expect(prompt).toContain("Location: line 22");
    expect(prompt).toContain("```diff\n@@ -20,2 +21,3 @@");
    expect(prompt).toContain("input is a constant from our build script");
    expect(prompt).toContain('File: "src/app.ts"');
    expect(prompt).toContain("```markdown\n`eval` runs arbitrary code.\n```");
  });

  it("says when the hunk and note are missing, and truncates long parts", () => {
    const prompt = buildLearnRulePrompt({
      finding: { ...finding, body: "x".repeat(50_000) },
      hunk: null,
      note: null,
    });
    expect(prompt).toContain("(not available)");
    expect(prompt).toContain("(none;");
    expect(prompt).toContain("[… truncated]");
    expect(prompt.length).toBeLessThan(5000);
  });
});
