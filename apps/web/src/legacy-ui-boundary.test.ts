import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Keeps `@iamthemcmaster/ui` (Precision Aurora) inside today's screens, so Epic 14 only has to
 * remove it. A file may use the library only if it is under `src/app/(app)/` (today's screens),
 * is the root layout's two library stylesheet imports, or is listed in
 * `LEGACY_SCREEN_MODULES`. Everything else (the signed-out pages, the shells, toasts) uses
 * `@omniralph/ui`.
 */

const SRC = path.resolve(__dirname);
const LIBRARY = /["']@iamthemcmaster\/ui(?:\/[^"']*)?["']/;

/**
 * Modules outside `src/app/(app)/` that only today's screens use, and so may still use the
 * library (directly, or through another module in this list). Each one is imported only from
 * `src/app/(app)/` or from another module here; a test file counts as part of the module it
 * tests. This list shrinks as Epics 5–10 replace today's screens, and is empty before Epic 14
 * removes the library.
 */
const LEGACY_SCREEN_MODULES: readonly string[] = [
  "src/components/app-header.tsx",
  "src/components/freshness.tsx",
  "src/components/list-pagination.tsx",
  "src/components/list-table.tsx",
  "src/components/mono-value.tsx",
  "src/components/page-header.tsx",
  "src/components/page-tabs.tsx",
  "src/components/pickers/index.ts",
  "src/components/pickers/model-picker.tsx",
  "src/components/pickers/multi-select.tsx",
  "src/components/pickers/picker-parts.tsx",
  "src/components/pickers/tag-input.tsx",
  "src/components/query-boundary.tsx",
  "src/components/ralph-badges.tsx",
  // Uses `Timestamp` from list-table.
  "src/components/relative-time.tsx",
  "src/components/review-badges.tsx",
  "src/components/settings-card.tsx",
  "src/components/settings-section.tsx",
  // Measures globals.css's severity chips against the library's tokens.
  "src/components/severity-ramp.test.ts",
  "src/components/unsaved-changes.tsx",
  "src/lib/state-variants.ts",
];

/**
 * The 2.0 screens (Epic 5 on): their views, the run components and their pages build on
 * `@omniralph/ui` only.
 */
const SCREENS_2_0 = [
  /^src\/screens\//,
  /^src\/components\/runs\//,
  /^src\/app\/\(app\)\/page\.tsx$/,
  /^src\/app\/\(app\)\/runs\//,
];

/** Files that must not reference the library at all. */
const LIBRARY_FREE = [
  ...SCREENS_2_0,
  /^src\/app\/\(auth\)\//,
  /^src\/app\/\(legal\)\//,
  /^src\/components\/auth-shell\.tsx$/,
  /^src\/components\/legal-shell\.tsx$/,
  /^src\/components\/app-shell\.tsx$/,
  /^src\/components\/use-api-mutation\.ts$/,
  /^src\/components\/use-settings-save\.ts$/,
];

const ROOT_LAYOUT = "src/app/layout.tsx";
const ROOT_LAYOUT_IMPORTS = [
  'import "@iamthemcmaster/ui/styles";',
  'import "@iamthemcmaster/ui/styles/fonts";',
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const SELF = "src/legacy-ui-boundary.test.ts";
const files = walk(SRC)
  .filter((file) => /\.(tsx?|css)$/.test(file))
  .map((file) => path.relative(path.dirname(SRC), file).split(path.sep).join("/"))
  .filter((file) => file !== SELF);
const source = new Map(
  files.map((file) => [file, readFileSync(path.join(path.dirname(SRC), file), "utf8")]),
);

const isScreen = (file: string) => file.startsWith("src/app/(app)/");
const TEST_FILE = /\.test\.(tsx?)$/;

/** The module a test file tests (`x.test.tsx` → `x.tsx` or `x.ts`), if it exists. */
function subjectOf(file: string): string | null {
  const match = TEST_FILE.exec(file);
  if (!match) return null;
  const base = file.slice(0, match.index);
  return [`${base}.tsx`, `${base}.ts`].find((candidate) => source.has(candidate)) ?? null;
}

function isAllowlisted(file: string): boolean {
  if (LEGACY_SCREEN_MODULES.includes(file)) return true;
  const subject = subjectOf(file);
  return subject !== null && (LEGACY_SCREEN_MODULES.includes(subject) || isScreen(subject));
}

/** The source files a file imports (`@/…` and relative specifiers), resolved to paths. */
function importsOf(file: string): string[] {
  const specifiers = Array.from(
    source
      .get(file)!
      .matchAll(/(?:from\s+|import\s*\(\s*|import\s+|vi\.mock\(\s*)["']([^"']+)["']/g),
    ([, specifier]) => specifier!,
  );
  return specifiers.flatMap((specifier) => {
    let base: string;
    if (specifier.startsWith("@/")) base = `src/${specifier.slice(2)}`;
    else if (specifier.startsWith(".")) base = path.posix.join(path.posix.dirname(file), specifier);
    else return [];
    return [base, `${base}.tsx`, `${base}.ts`, `${base}/index.ts`, `${base}/index.tsx`].filter(
      (candidate) => source.has(candidate),
    );
  });
}

const libraryUsers = files.filter((file) => LIBRARY.test(source.get(file)!));

describe("@iamthemcmaster/ui boundary", () => {
  it("finds the library's users (sanity check)", () => {
    expect(libraryUsers).toContain(ROOT_LAYOUT);
    expect(libraryUsers.some(isScreen)).toBe(true);
  });

  it("is used only by today's screens, the root layout's stylesheets and the allowlist", () => {
    const outside = libraryUsers.filter(
      (file) => !isScreen(file) && file !== ROOT_LAYOUT && !isAllowlisted(file),
    );
    expect(outside).toEqual([]);
  });

  it("is referenced by the root layout only through its two stylesheet imports", () => {
    const lines = source
      .get(ROOT_LAYOUT)!
      .split("\n")
      .filter((line) => LIBRARY.test(line))
      .map((line) => line.trim());
    expect(lines).toEqual(ROOT_LAYOUT_IMPORTS);
  });

  it("lists only modules that exist outside today's screens", () => {
    for (const entry of LEGACY_SCREEN_MODULES) {
      expect(existsSync(path.join(path.dirname(SRC), entry)), entry).toBe(true);
      expect(entry).toMatch(/^src\/(components|lib)\//);
    }
  });

  it("keeps allowlisted modules to today's screens and other allowlisted modules", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (isScreen(file) || isAllowlisted(file)) continue;
      for (const imported of importsOf(file)) {
        if (LEGACY_SCREEN_MODULES.includes(imported)) offenders.push(`${file} → ${imported}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("is never the source of a toast", () => {
    const offenders = files.filter((file) => {
      const text = source.get(file)!;
      const named = Array.from(
        text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']@iamthemcmaster\/ui["']/g),
        ([, names]) => names!.split(",").map((name) => name.trim().split(/\s+as\s+/)[0]),
      ).flat();
      return (
        named.includes("notify") ||
        named.includes("SonnerToaster") ||
        /\bSonnerToaster\b/.test(text)
      );
    });
    expect(offenders).toEqual([]);
  });

  it("is never the source of the navigation (the 2.0 shell draws it)", () => {
    const sidebar = /^(?:Sidebar\w*|useSidebar)$/;
    const offenders = files.flatMap((file) =>
      Array.from(
        source
          .get(file)!
          .matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']@iamthemcmaster\/ui["']/g),
        ([, names]) => names!.split(",").map((name) => name.trim().split(/\s+as\s+/)[0]!),
      )
        .flat()
        .filter((name) => sidebar.test(name))
        .map((name) => `${file}: ${name}`),
    );
    expect(offenders).toEqual([]);
    // Every file that imports the library names its imports (no namespace import to hide in).
    expect(
      files.filter((file) =>
        /import\s+\*\s+as\s+\w+\s+from\s+["']@iamthemcmaster\/ui["']/.test(source.get(file)!),
      ),
    ).toEqual([]);
  });

  it("is not used at all by the signed-out pages, the shells or the toast callers", () => {
    const offenders = files.filter(
      (file) =>
        LIBRARY_FREE.some((pattern) => pattern.test(file)) && LIBRARY.test(source.get(file)!),
    );
    expect(offenders).toEqual([]);
  });

  it("is not imported by the 2.0 screens, the run components or their pages", () => {
    const screens = files.filter((file) => SCREENS_2_0.some((pattern) => pattern.test(file)));
    // Sanity check: the Inbox is among them.
    expect(screens).toContain("src/screens/inbox/inbox-view.tsx");
    expect(screens).toContain("src/app/(app)/page.tsx");
    expect(screens.filter((file) => LIBRARY.test(source.get(file)!))).toEqual([]);
    // Nor through a module only today's screens may use.
    const throughLegacy = screens.flatMap((file) =>
      importsOf(file)
        .filter((imported) => LEGACY_SCREEN_MODULES.includes(imported))
        .map((imported) => `${file} → ${imported}`),
    );
    expect(throughLegacy).toEqual([]);
  });

  it("leaves the page's background, text color and font to the Ultraviolet tokens", () => {
    const css = source.get("src/app/globals.css")!.replace(/\/\*[\s\S]*?\*\//g, "");
    const page = /(?:^|\})\s*html,\s*body\s*\{([^}]*)\}/.exec(css);
    expect(page).not.toBeNull();
    expect(page![1]).toMatch(/background:\s*var\(--or-page\);/);
    expect(page![1]).toMatch(/color:\s*var\(--or-text\);/);
    expect(page![1]).toMatch(/font-family:\s*var\(--or-font-sans\);/);
    expect(page![1]).not.toMatch(/--bg-page|--text-primary|--font-body/);
  });
});
