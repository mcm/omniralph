import { describe, expect, it } from "vitest";
import { excerpt, failingTests, stripAnsi } from "./text.js";

const COLOURED =
  "\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m src/a.test.ts\u001b[2m > \u001b[22mworks";

describe("stripAnsi", () => {
  it("removes colours and OSC links", () => {
    expect(stripAnsi(COLOURED)).toBe(" FAIL  src/a.test.ts > works");
    expect(stripAnsi("\u001b]8;;https://x\u0007link\u001b]8;;\u0007")).toBe("link");
  });
});

describe("excerpt", () => {
  const gateFailure = (lines: number) =>
    [
      "The agent reported the story complete, but the quality gate `pnpm test` failed (exit 1):",
      "",
      "```",
      ...Array.from({ length: lines }, (_, i) => `\u001b[31moutput line ${i}\u001b[39m`),
      "```",
    ].join("\n");

  it("returns short text as it is, without escape sequences", () => {
    expect(excerpt(gateFailure(2), 1500)).toBe(
      "The agent reported the story complete, but the quality gate `pnpm test` failed (exit 1):\n\n```\noutput line 0\noutput line 1\n```",
    );
  });

  it("keeps the lead and reopens the code block the cut lands in", () => {
    const text = excerpt(gateFailure(500), 400);
    expect(text.length).toBeLessThanOrEqual(420);
    expect(text).toMatch(
      /^The agent reported the story complete, but the quality gate `pnpm test` failed \(exit 1\):\n\n```\n…\noutput line \d+\n/,
    );
    expect(text).toMatch(/output line 499\n```$/);
    expect(text.match(/```/g)).toHaveLength(2);
    expect(text).not.toContain("\u001b");
  });

  it("cuts at a line outside code blocks without a fence", () => {
    const text = excerpt(Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n"), 100);
    expect(text).toMatch(/^…\nline \d+\n/);
    expect(text).toMatch(/line 199$/);
    expect(text).not.toContain("```");
  });

  it("drops a lead too long to keep", () => {
    const text = excerpt(`${"x".repeat(300)}\n\n\`\`\`\n${"y\n".repeat(300)}\`\`\``, 200);
    expect(text).not.toContain("x");
    expect(text.startsWith("```\n…\ny\n")).toBe(true);
  });

  it("keeps the end of a single overlong line", () => {
    expect(excerpt("a".repeat(50) + "end", 10)).toBe("…aaaaaaaend");
  });
});

describe("failingTests", () => {
  it("lists Vitest's and Jest's FAIL lines once each", () => {
    const output = [COLOURED, COLOURED, " FAIL src/b.test.ts", "PASS src/c.test.ts"].join("\n");
    expect(failingTests(output)).toEqual(["src/a.test.ts > works", "src/b.test.ts"]);
  });

  it("stops at the limit", () => {
    const output = Array.from({ length: 9 }, (_, i) => `FAIL t${i}`).join("\n");
    expect(failingTests(output, 3)).toEqual(["t0", "t1", "t2"]);
  });
});
