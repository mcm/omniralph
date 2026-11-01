// Builds the omniralph-prd Claude plugin from packages/planning into a directory laid out as
// its marketplace repo (mcm/omniralph-prd): .claude-plugin/marketplace.json and
// plugins/omniralph-prd/ (plugin.json, skills/omniralph-prd/SKILL.md and its references).
// publish-prd-plugin.yml runs it on pushes to main and commits the result there when it changed.
// See docs/prd-plugin.md.
//
// Usage: pnpm exec tsx scripts/build-prd-plugin.ts --out <dir>
import path from "node:path";
import { parseArgs } from "node:util";

import { writePluginMarketplace } from "../packages/planning/src/plugin/build.js";

const { values } = parseArgs({ options: { out: { type: "string" } } });
if (!values.out) {
  console.error("Usage: pnpm exec tsx scripts/build-prd-plugin.ts --out <dir>");
  process.exit(2);
}

const outDir = path.resolve(values.out);
const written = await writePluginMarketplace(outDir);
console.log(`Wrote ${written.length} files to ${outDir}:`);
for (const file of written) console.log(`  ${file}`);
