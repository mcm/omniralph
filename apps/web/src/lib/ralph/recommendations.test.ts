import { MAX_RALPH_RECOMMENDATIONS, MAX_RALPH_RESULT_RECOMMENDATIONS } from "@omniralph/shared";
import { describe, expect, it } from "vitest";
import { addRecommendations } from "./recommendations";

describe("addRecommendations", () => {
  const now = new Date("2026-10-14T10:00:00.000Z");
  const earlier = "2026-10-13T10:00:00.000Z";

  it("keeps one per title, the latest wording moved last", () => {
    const stored = [
      { title: "Fix the parser upstream", description: "old", at: earlier },
      { title: "Bump the SDK", description: "In acme/sdk.", at: earlier },
    ];
    expect(
      addRecommendations(stored, [{ title: "fix the parser upstream", description: "new" }], now),
    ).toEqual([
      { title: "Bump the SDK", description: "In acme/sdk.", at: earlier },
      { title: "fix the parser upstream", description: "new", at: now.toISOString() },
    ]);
  });

  it("caps the list to the latest ones", () => {
    const added = Array.from({ length: 25 }, (_, i) => ({ title: `R${i}`, description: "x" }));
    const kept = addRecommendations([], added, now);
    expect(kept).toHaveLength(20);
    expect(kept[0]!.title).toBe("R5");
  });

  it("keeps earlier attempts' when a result adds as many as one may", () => {
    const stored = Array.from({ length: 20 }, (_, i) => ({
      title: `S${i}`,
      description: "x",
      at: earlier,
    }));
    const added = Array.from({ length: MAX_RALPH_RESULT_RECOMMENDATIONS }, (_, i) => ({
      title: `R${i}`,
      description: "x",
    }));
    const kept = addRecommendations(stored, added, now);
    expect(kept.filter((r) => r.title.startsWith("S"))).toHaveLength(
      MAX_RALPH_RECOMMENDATIONS - MAX_RALPH_RESULT_RECOMMENDATIONS,
    );
  });
});
