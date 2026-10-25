import { CURSOR_LARGE, CURSOR_SMALL, CURSOR_VIEWBOX, cursorTransform } from "./geometry.js";

/** Tile A: the violet tile behind the favicon and home-screen icon, never theme-swapped. */
export const TILE_COLOR = "#6236D6";
/** The mark's color on tile A. */
export const TILE_MARK_COLOR = "#FFFFFF";
/** Corner radius of the rounded tile, in viewBox units. */
export const TILE_RADIUS = 5.5;

export interface TileSvgOptions {
  /** Width and height in pixels. */
  size: number;
  master: "small" | "large";
  /** `rounded` for the favicon; `square` (full bleed) where the platform applies its own mask. */
  shape: "rounded" | "square";
}

/** Tile A (violet tile, white ring and cursor) as a standalone SVG document. */
export function tileSvg({ size, master, shape }: TileSvgOptions): string {
  const m = master === "small" ? CURSOR_SMALL : CURSOR_LARGE;
  const { circle, rect } = m;
  const radius = shape === "rounded" ? ` rx="${TILE_RADIUS}"` : "";
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${CURSOR_VIEWBOX} ${CURSOR_VIEWBOX}">`,
    `<rect width="${CURSOR_VIEWBOX}" height="${CURSOR_VIEWBOX}"${radius} fill="${TILE_COLOR}"/>`,
    `<g transform="${cursorTransform(m)}">`,
    `<circle cx="${circle.cx}" cy="${circle.cy}" r="${circle.r}" fill="none" stroke="${TILE_MARK_COLOR}" stroke-width="${circle.strokeWidth}"/>`,
    `<rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" rx="${rect.rx}" fill="${TILE_MARK_COLOR}"/>`,
    `</g>`,
    `</svg>`,
    "",
  ].join("\n");
}
