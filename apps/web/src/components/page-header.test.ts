import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const src = resolve(__dirname, "..");
const appRoutes = join(src, "app", "(app)");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const sources = walk(src).filter((path) => path.endsWith(".tsx") && !path.endsWith(".test.tsx"));

/** The page plus every module it reaches through relative imports. */
function reachableModules(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/from "(\.{1,2}\/[^"]+)"/g)) {
      const base = resolve(dirname(file), match[1]!);
      const resolved = [`${base}.tsx`, `${base}.ts`].find((candidate) => existsSync(candidate));
      if (resolved) queue.push(resolved);
    }
  }
  return [...seen];
}

describe("page headers", () => {
  const pages = walk(appRoutes)
    .filter((path) => path.endsWith("page.tsx"))
    // The 2.0 screens (the Inbox at the root, Runs, Backlog, Repos, Settings) title themselves
    // without today's PageHeader.
    .filter((path) => path !== join(appRoutes, "page.tsx"))
    .filter((path) => !path.startsWith(join(appRoutes, "runs") + sep))
    .filter((path) => !path.startsWith(join(appRoutes, "backlog") + sep))
    .filter((path) => !path.startsWith(join(appRoutes, "repos") + sep))
    .filter((path) => !path.startsWith(join(appRoutes, "settings") + sep));

  it.each(pages.map((page) => [relative(appRoutes, page), page]))(
    "%s renders the shared PageHeader",
    (_name, page) => {
      const usesHeader = reachableModules(page).some((file) =>
        readFileSync(file, "utf8").includes("<PageHeader"),
      );
      expect(usesHeader).toBe(true);
    },
  );

  it("app pages don't hand-roll their h1", () => {
    const offenders = walk(appRoutes)
      .filter((path) => path.endsWith(".tsx") && !path.endsWith(".test.tsx"))
      .filter((path) => /<h1\b|<H1\b|as="h1"/.test(readFileSync(path, "utf8")))
      .map((path) => relative(src, path));
    expect(offenders).toEqual([]);
  });
});

describe("heading outline", () => {
  // The library defaults (CardTitle h3, AlertTitle h5, Empty h3) skip levels under a page h1,
  // so every use states the level that continues the outline.
  it("every CardTitle and AlertTitle passes `as`", () => {
    const offenders = sources.flatMap((path) =>
      [...readFileSync(path, "utf8").matchAll(/<(CardTitle|AlertTitle)\b(?![^>]*\bas=)/g)].map(
        (match) => `${relative(src, path)}: ${match[1]}`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("every Empty with a title passes `titleAs`", () => {
    const offenders = sources.flatMap((path) =>
      [...readFileSync(path, "utf8").matchAll(/<Empty\b[^>]*>/g)]
        .filter((match) => /\btitle=/.test(match[0]) && !/\btitleAs=/.test(match[0]))
        .map(() => relative(src, path)),
    );
    expect(offenders).toEqual([]);
  });
});
