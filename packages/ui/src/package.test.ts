import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8")) as {
  exports: Record<string, unknown>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

describe("@omniralph/ui package", () => {
  it("depends on neither Next.js nor @iamthemcmaster", () => {
    const names = [
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.peerDependencies ?? {}),
    ];
    const forbidden = names.filter(
      (name) => name.startsWith("next") || name.startsWith("@iamthemcmaster/"),
    );
    expect(forbidden).toEqual([]);
  });

  it.each(["./styles.css", "./fonts.css"])("ships the stylesheet %s names", (entry) => {
    const target = packageJson.exports[entry];
    expect(typeof target).toBe("string");
    expect(existsSync(path.join(packageDir, target as string))).toBe(true);
  });

  it("imports the tokens from styles.css and both font families from fonts.css", () => {
    const index = readFileSync(path.join(packageDir, "styles/index.css"), "utf8");
    expect(index).toMatch(/@import\s+"\.\/tokens\.css"/);
    const fonts = readFileSync(path.join(packageDir, "styles/fonts.css"), "utf8");
    expect(fonts).toMatch(/@import\s+"@fontsource-variable\/instrument-sans"/);
    expect(fonts).toMatch(/@import\s+"@fontsource-variable\/geist-mono"/);
    expect(fonts).toMatch(/--or-font-sans:\s*"Instrument Sans Variable".*system-ui, sans-serif;/);
    expect(fonts).toMatch(/--or-font-mono:\s*"Geist Mono Variable".*ui-monospace, monospace;/);
  });

  it.each([
    'import Link from "next/link";\n\nexport const X = Link;\n',
    'import { cookies } from "next";\n\nexport const X = cookies;\n',
    'import { Button } from "@iamthemcmaster/ui";\n\nexport const X = Button;\n',
  ])("lint forbids %s", async (source) => {
    const eslint = new ESLint({ cwd: packageDir });
    const [result] = await eslint.lintText(source, { filePath: "src/x.tsx" });
    const rules = result!.messages.map((message) => message.ruleId);
    expect(rules).toContain("no-restricted-imports");
  });
});
