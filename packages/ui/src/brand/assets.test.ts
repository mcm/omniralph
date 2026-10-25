import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BRAND_ASSETS } from "./assets.js";
import { tileSvg } from "./tile.js";

const publicDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../apps/web/public",
);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width, height and color type from a PNG's IHDR chunk (always the first chunk). */
function readIhdr(file: string) {
  const png = readFileSync(path.join(publicDir, file));
  expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  expect(png.toString("ascii", 12, 16)).toBe("IHDR");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), colorType: png[25] };
}

function assetFor(file: string) {
  return BRAND_ASSETS.find((asset) => asset.file === file)!;
}

describe("favicon set (regenerate with `pnpm --filter @omniralph/ui brand-assets`)", () => {
  it("writes favicon.svg as the rounded small-master tile", () => {
    expect(assetFor("favicon.svg").tile).toMatchObject({ master: "small", shape: "rounded" });
    expect(readFileSync(path.join(publicDir, "favicon.svg"), "utf8")).toBe(
      tileSvg(assetFor("favicon.svg").tile),
    );
  });

  it("writes favicon-32.png at 32×32 from the rounded small-master tile", () => {
    expect(assetFor("favicon-32.png").tile).toEqual({
      size: 32,
      master: "small",
      shape: "rounded",
    });
    expect(readIhdr("favicon-32.png")).toMatchObject({ width: 32, height: 32 });
  });

  it("writes apple-touch-icon.png at 180×180 from the square large-master tile, with no alpha", () => {
    expect(assetFor("apple-touch-icon.png").tile).toEqual({
      size: 180,
      master: "large",
      shape: "square",
    });
    // Color type 2 is truecolor RGB without an alpha channel.
    expect(readIhdr("apple-touch-icon.png")).toEqual({ width: 180, height: 180, colorType: 2 });
  });
});
