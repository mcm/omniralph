import { describe, expect, it } from "vitest";
import { ciLogTail, cleanCiLog, MAX_CI_LOG_CHARS } from "./ci.js";

describe("CI logs", () => {
  it("strips ANSI colours and GitLab section markers", () => {
    expect(
      cleanCiLog(
        "section_start:1700000000:step_script\r\u001b[0K\u001b[31mFAIL\u001b[0m test/a.test.ts\r\n",
      ),
    ).toBe("FAIL test/a.test.ts\n");
    expect(cleanCiLog("a\r\nb\rc\nsection_end:1700000001:step_script\r\u001b[0Kdone")).toBe(
      "a\nb\nc\ndone",
    );
  });

  it("keeps only the last 4,000 chars, prefixed with …", () => {
    expect(ciLogTail("short\r\n")).toBe("short\n");
    const tail = ciLogTail(`\u001b[31m${"x".repeat(5000)}\nExpected 2, got 3\u001b[0m`);
    expect(tail.startsWith("…x")).toBe(true);
    expect(tail.endsWith("\nExpected 2, got 3")).toBe(true);
    expect(tail).toHaveLength(MAX_CI_LOG_CHARS + 1);
    expect(ciLogTail("y".repeat(MAX_CI_LOG_CHARS))).toBe("y".repeat(MAX_CI_LOG_CHARS));
  });
});
