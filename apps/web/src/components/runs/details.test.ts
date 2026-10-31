import { describe, expect, it } from "vitest";
import { attemptsText, formatTokens, tokensText } from "./details";

describe("tokensText", () => {
  it("reads in and out in compact form", () => {
    expect(tokensText({ in: 45_200_000, out: 225_000 })).toBe("45.2M in · 225k out");
    expect(tokensText({ in: 0, out: 950 })).toBe("0 in · 950 out");
    expect(formatTokens(8_400)).toBe("8.4k");
  });
});

describe("attemptsText", () => {
  it("counts one attempt in the singular", () => {
    expect(attemptsText(1)).toBe("1 attempt");
    expect(attemptsText(7)).toBe("7 attempts");
  });
});
