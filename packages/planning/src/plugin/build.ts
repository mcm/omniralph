/**
 * Writes the omniralph-prd plugin into a checkout of its marketplace repo.
 * The plugin's directory is replaced whole, so a reference dropped here
 * disappears there too; files outside it (a README, the git history) are left
 * alone apart from the marketplace manifest.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { PLUGIN_DIR, renderPluginFiles } from "./render.js";

/** Writes every plugin file under `outDir` and returns their paths, relative to it. */
export async function writePluginMarketplace(outDir: string): Promise<string[]> {
  await rm(path.join(outDir, PLUGIN_DIR), { recursive: true, force: true });
  const files = renderPluginFiles();
  for (const file of files) {
    const target = path.join(outDir, ...file.path.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
  return files.map((file) => file.path);
}
