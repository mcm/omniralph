import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

  it("imports every component stylesheet from styles.css", () => {
    const index = readFileSync(path.join(packageDir, "styles/index.css"), "utf8");
    const sheets = readdirSync(path.join(packageDir, "styles")).filter(
      (file) => file.endsWith(".css") && file !== "index.css" && file !== "fonts.css",
    );
    const missing = sheets.filter(
      (file) => !new RegExp(`@import\\s+"\\./${file.replace(".", "\\.")}"`).test(index),
    );
    expect(missing).toEqual([]);
  });

  it("renders no keyboard-shortcut indicators in any component (Design rule 7)", () => {
    const sources = [
      ...readdirSync(path.join(packageDir, "src"), { recursive: true, encoding: "utf8" })
        .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
        .map((file) => path.join("src", file)),
      ...readdirSync(path.join(packageDir, "styles")).map((file) => path.join("styles", file)),
    ];
    const offenders = sources.filter((file) =>
      /\bkbd\b|⌘/i.test(readFileSync(path.join(packageDir, file), "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
