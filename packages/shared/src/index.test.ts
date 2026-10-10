import { describe, expect, it } from "vitest";
import { isCapability } from "./index.js";

describe("isCapability", () => {
  it("accepts known capabilities", () => {
    expect(isCapability("review")).toBe(true);
    expect(isCapability("ralph")).toBe(true);
    expect(isCapability("triage")).toBe(true);
  });

  it("rejects unknown capabilities", () => {
    expect(isCapability("deploy")).toBe(false);
  });
});
