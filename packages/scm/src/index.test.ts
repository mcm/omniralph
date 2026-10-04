import { describe, expect, it } from "vitest";
import { packageName } from "./index.js";

describe("@omniralph/scm", () => {
  it("exports its package name", () => {
    expect(packageName).toBe("@omniralph/scm");
  });
});
