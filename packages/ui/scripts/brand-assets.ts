// Writes the favicon set (tile A) into apps/web/public from `tileSvg`:
//   pnpm --filter @omniralph/ui brand-assets
// The outputs are committed; `src/brand/assets.test.ts` fails when they drift.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { BRAND_ASSETS } from "../src/brand/assets.js";
import { tileSvg } from "../src/brand/tile.js";

const publicDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../apps/web/public",
);
mkdirSync(publicDir, { recursive: true });

for (const asset of BRAND_ASSETS) {
  const svg = tileSvg(asset.tile);
  const file = path.join(publicDir, asset.file);
  if (asset.format === "svg") {
    writeFileSync(file, svg);
  } else {
    // Render at the target size; `removeAlpha` makes the opaque tiles RGB (no alpha channel).
    let image = sharp(Buffer.from(svg), { density: 72 * (asset.tile.size / 24) }).resize(
      asset.tile.size,
      asset.tile.size,
    );
    if (asset.opaque) image = image.flatten({ background: "#6236D6" }).removeAlpha();
    writeFileSync(file, await image.png().toBuffer());
  }
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}
