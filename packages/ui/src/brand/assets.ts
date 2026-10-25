import type { TileSvgOptions } from "./tile.js";

/** One file of the favicon set written by `scripts/brand-assets.ts` into apps/web/public. */
export interface BrandAsset {
  file: string;
  format: "svg" | "png";
  tile: TileSvgOptions;
  /** Rendered without an alpha channel (iOS applies its own mask). */
  opaque?: boolean;
}

/** The favicon set: always tile A, never theme-swapped. */
export const BRAND_ASSETS: readonly BrandAsset[] = [
  { file: "favicon.svg", format: "svg", tile: { size: 24, master: "small", shape: "rounded" } },
  { file: "favicon-32.png", format: "png", tile: { size: 32, master: "small", shape: "rounded" } },
  {
    file: "apple-touch-icon.png",
    format: "png",
    tile: { size: 180, master: "large", shape: "square" },
    opaque: true,
  },
];
