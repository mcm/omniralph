import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BRAND_NAMES, BrandMark, type Brand } from "./brand-mark.js";

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const BRANDS: [Brand, string][] = [
  ["github", "GitHub"],
  ["gitlab", "GitLab"],
  ["linear", "Linear"],
  ["slack", "Slack"],
  ["discord", "Discord"],
];

describe("BrandMark", () => {
  it.each(BRANDS)("renders %s as an image named %s", (brand, name) => {
    render(<BrandMark brand={brand} />);
    const mark = screen.getByRole("img", { name });
    expect(mark.tagName.toLowerCase()).toBe("svg");
    expect(mark.getAttribute("aria-label")).toBe(name);
    expect(mark.getAttribute("width")).toBe("14");
    expect(BRAND_NAMES[brand]).toBe(name);
  });

  it.each(BRANDS.filter(([brand]) => brand !== "slack"))(
    "renders the mono %s mark in currentColor",
    (brand) => {
      const { container } = render(<BrandMark brand={brand} size={18} />);
      const svg = container.querySelector("svg")!;
      expect(svg.getAttribute("fill")).toBe("currentColor");
      expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(svg.getAttribute("height")).toBe("18");
      expect(svg.querySelector("[fill]:not([fill='currentColor'])")).toBeNull();
    },
  );

  it("marks Slack (no mono variant upstream) for the currentColor override", () => {
    const { container } = render(<BrandMark brand="slack" />);
    expect(container.querySelector("svg")!.getAttribute("class")).toBe(
      "or-brand-mark or-brand-mark--slack",
    );
    const css = readFileSync(path.resolve(srcDir, "../styles/refs.css"), "utf8");
    expect(css).toMatch(/\.or-brand-mark--slack path\s*\{\s*fill:\s*currentColor;\s*\}/);
  });

  it("never imports the @thesvg/react root index", () => {
    const imports = sourceFiles(srcDir).flatMap((file) =>
      Array.from(
        readFileSync(file, "utf8").matchAll(/from\s+["'](@thesvg\/react[^"']*)["']/g),
        ([, specifier]) => specifier!,
      ),
    );
    expect(imports.length).toBeGreaterThanOrEqual(5);
    for (const specifier of imports) {
      expect(specifier).toMatch(/^@thesvg\/react\/[a-z0-9-]+$/);
    }
  });
});
