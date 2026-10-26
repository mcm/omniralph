import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { installablePackageDir, installablesPrefix } from "../installables.js";

/**
 * Places a package in the installables prefix under `dataDir` as `npm install`
 * would leave it: its package.json and `files` (executable, by path relative to
 * the package) in node_modules, and a dependency in the prefix's package.json.
 * Returns the package directory.
 */
export async function placeInstallable(
  dataDir: string,
  packageJson: { name: string; version: string } & Record<string, unknown>,
  files: Record<string, string> = {},
): Promise<string> {
  const prefix = installablesPrefix(dataDir);
  const dir = installablePackageDir(prefix, packageJson.name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify(packageJson));
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(dir, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
    await chmod(target, 0o755);
  }
  const prefixJson = path.join(prefix, "package.json");
  type PrefixJson = Record<string, unknown> & { dependencies?: Record<string, string> };
  const current = await readFile(prefixJson, "utf8").then(
    (text) => JSON.parse(text) as PrefixJson,
    (): PrefixJson => ({ name: "omniralph-installables", private: true }),
  );
  await writeFile(
    prefixJson,
    JSON.stringify({
      ...current,
      dependencies: { ...current.dependencies, [packageJson.name]: packageJson.version },
    }),
  );
  return dir;
}
