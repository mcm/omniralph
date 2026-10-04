import { describe, expect, it } from "vitest";
import { packageName } from "./index.js";

describe("@omniralph/engine", () => {
  it("exports its package name", () => {
    expect(packageName).toBe("@omniralph/engine");
  });
});
