import { describe, expect, it } from "vitest";
import { parseDiff } from "../diff.js";
import { extractPartialFindings, filterToDiff, parseFindingsOutput } from "./findings-output.js";

const f = {
  path: "a.ts",
  startLine: 1,
  endLine: 1,
  severity: "low",
  category: "correctness",
  title: "t",
  body: "b",
  confidence: 0.5,
};

describe("parseFindingsOutput", () => {
  it("accepts a wrapper object, a bare array and fenced JSON", () => {
    expect(parseFindingsOutput(JSON.stringify({ findings: [f] }))).toEqual({
      ok: true,
      findings: [f],
    });
    expect(parseFindingsOutput(JSON.stringify([f]))).toEqual({ ok: true, findings: [f] });
    expect(
      parseFindingsOutput("Done.\n```json\n" + JSON.stringify({ findings: [] }) + "\n```"),
    ).toEqual({
      ok: true,
      findings: [],
    });
  });

  it("reports missing JSON, bad JSON, wrong shapes and invalid items", () => {
    expect(parseFindingsOutput("LGTM")).toMatchObject({
      ok: false,
      error: expect.stringContaining("no JSON"),
    });
    expect(parseFindingsOutput("{nope}")).toMatchObject({
      ok: false,
      error: expect.stringContaining("not valid JSON"),
    });
    expect(parseFindingsOutput('{"results": []}')).toMatchObject({ ok: false });
    const res = parseFindingsOutput(JSON.stringify({ findings: [f, { ...f, startLine: "x" }] }));
    expect(res).toMatchObject({
      ok: false,
      error: expect.stringContaining("findings[1].startLine"),
    });
    expect(res.ok === false && res.items).toHaveLength(2);
  });
});

describe("extractPartialFindings", () => {
  it("keeps complete findings from truncated output, ignoring braces in strings", () => {
    const tricky = { ...f, body: 'use `{}` and "}" carefully' };
    const text = `{"findings": [${JSON.stringify(f)}, ${JSON.stringify(tricky)}, {"path": "a.ts", "startL`;
    expect(extractPartialFindings(text)).toEqual([f, tricky]);
  });
});

describe("filterToDiff", () => {
  it("uses base-side lines for deleted files", () => {
    const files = parseDiff(`diff --git a/old.ts b/old.ts
deleted file mode 100644
index 1111111..0000000
--- a/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-one
-two
`);
    const { inside, outside } = filterToDiff(
      [
        { ...f, path: "old.ts", startLine: 1, endLine: 2 },
        { ...f, path: "old.ts", startLine: 3, endLine: 3 },
      ] as never,
      files,
    );
    expect(inside).toHaveLength(1);
    expect(outside).toHaveLength(1);
  });
});
