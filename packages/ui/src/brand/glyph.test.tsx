import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Glyph } from "./glyph.js";

function svgOf(container: HTMLElement) {
  return container.querySelector("svg")!;
}

describe("Glyph", () => {
  it("renders 24 px in a 24-unit viewBox by default", () => {
    const { container } = render(<Glyph />);
    const svg = svgOf(container);
    expect(svg.getAttribute("width")).toBe("24");
    expect(svg.getAttribute("height")).toBe("24");
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
  });

  it("strokes the ring with the text color and fills the cursor with the accent, without a tile", () => {
    const { container } = render(<Glyph />);
    const svg = svgOf(container);
    const circle = svg.querySelector("circle")!;
    expect(circle.getAttribute("stroke")).toBe("currentColor");
    expect(circle.getAttribute("cx")).toBe("9");
    expect(circle.getAttribute("cy")).toBe("11");
    expect(svg.querySelectorAll("rect")).toHaveLength(1);
    expect(svg.querySelector("rect")!.getAttribute("fill")).toBe("var(--or-acc)");
  });

  it("uses the small master at 32 px", () => {
    const { container } = render(<Glyph size={32} />);
    const svg = svgOf(container);
    expect(svg.querySelector("g")!.getAttribute("transform")).toBe(
      "translate(12 12) scale(0.92) translate(-12 -11)",
    );
    expect(svg.querySelector("circle")!.getAttribute("stroke-width")).toBe("2.8");
    const rect = svg.querySelector("rect")!;
    expect([rect.getAttribute("x"), rect.getAttribute("y")]).toEqual(["16", "14.2"]);
    expect([rect.getAttribute("width"), rect.getAttribute("height")]).toEqual(["5.5", "2.8"]);
    expect(rect.getAttribute("rx")).toBe("0.5");
  });

  it("uses the large master at 33 px", () => {
    const { container } = render(<Glyph size={33} />);
    const svg = svgOf(container);
    expect(svg.getAttribute("width")).toBe("33");
    expect(svg.querySelector("g")!.getAttribute("transform")).toBe(
      "translate(12 12) scale(0.8) translate(-12 -11)",
    );
    expect(svg.querySelector("circle")!.getAttribute("stroke-width")).toBe("2.6");
    const rect = svg.querySelector("rect")!;
    expect([rect.getAttribute("x"), rect.getAttribute("y")]).toEqual(["15", "14.9"]);
    expect([rect.getAttribute("width"), rect.getAttribute("height")]).toEqual(["6.5", "2.1"]);
    expect(rect.getAttribute("rx")).toBe("0.6");
  });

  it("is hidden from assistive tech without a label", () => {
    const { container } = render(<Glyph />);
    const svg = svgOf(container);
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("role")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("is an image named by its label", () => {
    render(<Glyph label="Omniralph" />);
    const img = screen.getByRole("img", { name: "Omniralph" });
    expect(img.getAttribute("aria-hidden")).toBeNull();
  });
});
