import type { Finding } from "@omniralph/shared";
import { describe, expect, it } from "vitest";
import { capFindings } from "./capFindings.js";

describe("capFindings", () => {
  const f = (title: string, severity: Finding["severity"], confidence = 0.5): Finding => ({
    path: "a.ts",
    startLine: 1,
    endLine: 1,
    severity,
    category: "correctness",
    title,
    body: "b",
    confidence,
  });

  it("keeps the most severe, then most confident, findings in their original order", () => {
    const findings = [
      f("low", "low"),
      f("high-unsure", "high", 0.4),
      f("info", "info"),
      f("critical", "critical"),
      f("high-sure", "high", 0.9),
    ];
    expect(capFindings(findings, 3).map((x) => x.title)).toEqual([
      "high-unsure",
      "critical",
      "high-sure",
    ]);
    expect(capFindings(findings, 2).map((x) => x.title)).toEqual(["critical", "high-sure"]);
    expect(capFindings(findings)).toEqual(findings);
  });

  it("fits ReviewJobResult however many findings the engine returns", () => {
    const many = Array.from({ length: 600 }, (_, i) => f(`f${i}`, i < 10 ? "critical" : "low"));
    const kept = capFindings(many);
    expect(kept).toHaveLength(500);
    expect(kept.filter((x) => x.severity === "critical")).toHaveLength(10);
  });
});
