import { describe, expect, it } from "vitest";
import { parseE2eOptions, playwrightArgs } from "./options";

describe("parseE2eOptions", () => {
  it("runs every spec by default", () => {
    const options = parseE2eOptions([]);
    expect(options).toEqual({ grep: null, grepInvert: null, skipBuild: false, help: false });
    expect(playwrightArgs(options)).toEqual([]);
  });

  it("passes --grep and --grep-invert to playwright test", () => {
    const options = parseE2eOptions(["--grep", "smoke|enroll", "--grep-invert", "slow"]);
    expect(playwrightArgs(options)).toEqual(["--grep", "smoke|enroll", "--grep-invert", "slow"]);
    expect(parseE2eOptions(["--grep=smoke"]).grep).toBe("smoke");
  });

  it("reads --skip-build and --help", () => {
    expect(parseE2eOptions(["--skip-build", "--help"])).toMatchObject({
      skipBuild: true,
      help: true,
    });
  });

  it("rejects an empty or invalid pattern and unknown options", () => {
    expect(() => parseE2eOptions(["--grep", " "])).toThrow("--grep needs a value");
    expect(() => parseE2eOptions(["--grep", "("])).toThrow("invalid regular expression");
    expect(() => parseE2eOptions(["--routes", "x"])).toThrow();
    expect(() => parseE2eOptions(["smoke"])).toThrow();
  });
});
