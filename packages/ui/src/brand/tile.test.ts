import { describe, expect, it } from "vitest";
import { tileSvg } from "./tile.js";

describe("tileSvg", () => {
  it("draws the 32 px rounded tile with the small master", () => {
    expect(tileSvg({ size: 32, master: "small", shape: "rounded" })).toMatchInlineSnapshot(`
      "<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24">
      <rect width="24" height="24" rx="5.5" fill="#6236D6"/>
      <g transform="translate(12 12) scale(0.92) translate(-12 -11)">
      <circle cx="9" cy="11" r="5" fill="none" stroke="#FFFFFF" stroke-width="2.8"/>
      <rect x="16" y="14.2" width="5.5" height="2.8" rx="0.5" fill="#FFFFFF"/>
      </g>
      </svg>
      "
    `);
  });

  it("draws the 180 px full-bleed square tile with the large master", () => {
    expect(tileSvg({ size: 180, master: "large", shape: "square" })).toMatchInlineSnapshot(`
      "<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 24 24">
      <rect width="24" height="24" fill="#6236D6"/>
      <g transform="translate(12 12) scale(0.8) translate(-12 -11)">
      <circle cx="9" cy="11" r="5" fill="none" stroke="#FFFFFF" stroke-width="2.6"/>
      <rect x="15" y="14.9" width="6.5" height="2.1" rx="0.6" fill="#FFFFFF"/>
      </g>
      </svg>
      "
    `);
  });
});
