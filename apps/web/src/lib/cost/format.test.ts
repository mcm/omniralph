import { describe, expect, it } from "vitest";
import { formatUsd as analyticsFormatUsd } from "@/lib/analytics/display";
import { COST_NOTE, formatUsd } from "./format";

describe("formatUsd", () => {
  it("formats US dollars with two decimals and thousands separators", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(12.34)).toBe("$12.34");
    expect(formatUsd(312.4)).toBe("$312.40");
    expect(formatUsd(1204.5)).toBe("$1,204.50");
    expect(formatUsd(0.01)).toBe("$0.01");
  });

  it("shows less than a cent as <$0.01, never $0.00", () => {
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(0.000001)).toBe("<$0.01");
    expect(formatUsd(0.00999)).toBe("<$0.01");
  });

  it("is the one formatter Analytics uses too", () => {
    expect(analyticsFormatUsd).toBe(formatUsd);
  });

  it("says what the figure means", () => {
    expect(COST_NOTE).toBe(
      "What these tokens would cost at Anthropic's API list prices, not what was billed.",
    );
  });
});
