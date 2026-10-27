import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.join(__dirname, "../..");
const DIRS = ["components/work-items", "screens/backlog"];

const read = (file: string) => readFileSync(path.join(SRC, file), "utf8");
const uncommented = (file: string) => read(file).replace(/\/\*[\s\S]*?\*\//g, "");
/** The declarations of `selector`'s first rule outside any at-rule. */
const rule = (css: string, selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
};

/** Every stylesheet of the Backlog and the work item components, with the module importing it. */
const stylesheets = DIRS.flatMap((dir) =>
  readdirSync(path.join(SRC, dir))
    .filter((name) => name.endsWith(".css"))
    .map((name) => `${dir}/${name}`),
);

describe("the Backlog and work item stylesheets", () => {
  it("are all found", () => {
    expect(stylesheets).toEqual(
      expect.arrayContaining([
        "components/work-items/prd-view.css",
        "screens/backlog/up-next.css",
        "screens/backlog/backlog.css",
      ]),
    );
  });

  it.each(stylesheets)("%s is imported by a module next to it", (file) => {
    const dir = path.dirname(file);
    const name = path.basename(file);
    const importers = readdirSync(path.join(SRC, dir))
      .filter((source) => /\.tsx?$/.test(source) && !/\.test\.tsx?$/.test(source))
      .filter((source) => read(`${dir}/${source}`).includes(`import "./${name}";`));
    expect(importers.length).toBeGreaterThan(0);
  });

  it.each(stylesheets)(
    "%s uses no color literals and only --or- tokens and or- classes",
    (file) => {
      const css = uncommented(file);
      expect(
        css.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/gi),
      ).toBeNull();
      const tokens = Array.from(css.matchAll(/var\((--[\w-]+)/g), ([, name]) => name!);
      expect(tokens.filter((name) => !name.startsWith("--or-"))).toEqual([]);
      const classes = Array.from(css.matchAll(/\.([a-z][\w-]*)/gi), ([, name]) => name!);
      expect(classes.filter((name) => !name.startsWith("or-"))).toEqual([]);
    },
  );
});

describe("PrdView's layout", () => {
  const css = uncommented("components/work-items/prd-view.css");
  const view = read("components/work-items/prd-view.tsx");

  it("renders the PRD in a 68ch column", () => {
    expect(rule(css, ".or-prd__body")).toMatch(/max-width:\s*68ch/);
    expect(view).toMatch(/<Markdown className="or-prd__body">/);
  });

  it("edits in a full-width mono textarea", () => {
    expect(rule(css, ".or-prd__editor")).toMatch(/width:\s*100%/);
    expect(view).toMatch(/<Textarea[\s\S]*?\bmono\b[\s\S]*?className="or-prd__editor"/);
  });
});

describe("Up next's layout", () => {
  it("is a card in the .upnext style: bordered, rounded, on the surface", () => {
    const card = rule(uncommented("screens/backlog/up-next.css"), ".or-upnext");
    expect(card).toMatch(/border:\s*1px solid var\(--or-line\)/);
    expect(card).toMatch(/border-radius:\s*var\(--or-radius-lg\)/);
    expect(card).toMatch(/background:\s*var\(--or-surf\)/);
  });
});
