import { describe, expect, it } from "vitest";
import { main, USAGE } from "./main.js";

function capture() {
  const out = { stdout: "", stderr: "" };
  return {
    out,
    io: {
      stdout: (text: string) => (out.stdout += text),
      stderr: (text: string) => (out.stderr += text),
    },
  };
}

describe("omniralph-agent CLI", () => {
  it("prints usage with --help", () => {
    const { out, io } = capture();
    expect(main(["--help"], io)).toBe(0);
    expect(out.stdout).toBe(USAGE);
  });

  it("rejects unknown commands", () => {
    const { out, io } = capture();
    expect(main(["frobnicate"], io)).toBe(1);
    expect(out.stderr).toContain("unknown command 'frobnicate'");
  });

  it("reports unimplemented commands using shared capabilities", () => {
    const { out, io } = capture();
    expect(main(["run"], io)).toBe(1);
    expect(out.stderr).toContain("capabilities: review");
  });
});
