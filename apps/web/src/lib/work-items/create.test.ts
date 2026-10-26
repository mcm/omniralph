import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "../..");

/**
 * The specifiers a module imports at runtime: static imports, re-exports and dynamic imports.
 * Type-only ones (`import type`, `export type … from`) are erased by the compiler and left out.
 */
function specifiers(source: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /\bimport\s+(?!type\s)[^"';]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bexport\s+(?!type\s)[^"';]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.add(match[1]!);
  }
  return [...found];
}

/** A local specifier's file under `src`, or null for a package. */
function resolveLocal(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = join(SRC, specifier.slice(2));
  else if (specifier.startsWith(".")) base = join(dirname(from), specifier);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate) && candidate.match(/\.tsx?$/)) return candidate;
  }
  throw new Error(`Can't resolve ${specifier} from ${relative(SRC, from)}`);
}

/** The modules `entry` loads (relative to `src`) and the packages they import. */
function importGraph(entry: string): { modules: Set<string>; packages: Set<string> } {
  const modules = new Set<string>();
  const packages = new Set<string>();
  const pending = [join(SRC, entry)];
  while (pending.length > 0) {
    const file = pending.pop()!;
    const name = relative(SRC, file);
    if (modules.has(name)) continue;
    modules.add(name);
    for (const specifier of specifiers(readFileSync(file, "utf8"))) {
      const local = resolveLocal(file, specifier);
      if (local) pending.push(local);
      else packages.add(specifier);
    }
  }
  return { modules, packages };
}

describe("createWorkItem's dependencies", () => {
  it("import nothing from Next, a request or the session, so a chat surface can call it", () => {
    expect(
      specifiers('import type { A } from "next/server";\nimport { b, type C } from "./d";'),
    ).toEqual(["./d"]);
    const { modules, packages } = importGraph("lib/work-items/create.ts");
    expect(modules).toContain("lib/work-items/get-tracker.ts");
    expect([...packages].filter((name) => /^next(\/|$)|^next-auth(\/|$)/.test(name))).toEqual([]);
    const forbidden = [...modules].filter(
      (name) =>
        name.startsWith("app/") ||
        name.startsWith("lib/auth/") ||
        /^lib\/api\/(handler|scope)\.ts$/.test(name) ||
        /^lib\/live\/request\.ts$/.test(name) ||
        /(^|\/)(session|request|cookies?)\.tsx?$/.test(name),
    );
    expect(forbidden).toEqual([]);
  });
});
