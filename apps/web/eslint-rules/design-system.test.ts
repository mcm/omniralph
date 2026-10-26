import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";
import {
  findRawColor,
  noArbitraryTailwind,
  noBareTimestamp,
  noInlineLayoutStyle,
  noRawColor,
} from "./design-system.mjs";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

describe("findRawColor", () => {
  it("finds hex and functional colors", () => {
    expect(findRawColor("#fff")).toBe("#fff");
    expect(findRawColor("1px solid #A1B2C3")).toBe("#A1B2C3");
    expect(findRawColor("#ff000080")).toBe("#ff000080");
    expect(findRawColor("rgba(0, 0, 0, 0.5)")).toBe("rgba(");
    expect(findRawColor("hsl(210 40% 50%)")).toBe("hsl(");
  });

  it("ignores issue numbers, fragments and tokens", () => {
    expect(findRawColor("Fixes #123")).toBeNull();
    expect(findRawColor("#settings")).toBeNull();
    expect(findRawColor("/ralph#runs")).toBeNull();
    expect(findRawColor("var(--accent)")).toBeNull();
    expect(findRawColor("#abcde")).toBeNull();
  });
});

ruleTester.run("no-raw-color", noRawColor, {
  valid: [
    `const c = "var(--text-primary)";`,
    `const x = <a href="#add">Add</a>;`,
    `const x = <div id="#face" />;`,
    `const label = "PR #123";`,
    "const t = `issue #${n}`;",
    `const x = <p>Use #fff for nothing</p>;`,
  ],
  invalid: [
    { code: `const c = "#fff";`, errors: [{ messageId: "rawColor" }] },
    {
      code: `const x = <div style={{ color: "#0a0a0a" }} />;`,
      errors: [{ messageId: "rawColor" }],
    },
    { code: `const x = <rect fill="#FF00AA" />;`, errors: [{ messageId: "rawColor" }] },
    { code: "const s = `1px solid rgb(${r}, 0, 0)`;", errors: [{ messageId: "rawColor" }] },
    { code: `const c = "rgba(0, 0, 0, 0.4)";`, errors: [{ messageId: "rawColor" }] },
    { code: `const c = "hsla(200, 50%, 50%, 1)";`, errors: [{ messageId: "rawColor" }] },
    { code: `const c = { bg: "hsl(200 50% 50%)" };`, errors: [{ messageId: "rawColor" }] },
  ],
});

ruleTester.run("no-inline-layout-style", noInlineLayoutStyle, {
  valid: [
    // Computed values are dynamic.
    `const x = <div style={{ width: \`\${pct}%\` }} />;`,
    `const x = <div style={{ width: size, height: size }} />;`,
    `const x = <div style={{ color: palette[i] }} />;`,
    // Custom properties and properties outside the guarded categories.
    `const x = <div style={{ "--bar": 3 }} />;`,
    `const x = <div style={{ cursor: "pointer", transition: "none" }} />;`,
    // A style object built elsewhere or imported can't be resolved.
    `const x = <div style={styles} />;`,
    `const x = <div style={grid("1fr 1fr")} />;`,
    `let s = { display: "flex" }; s = {}; const x = <div style={s} />;`,
    // The escape hatch: a reason on the line before.
    `const x = (
      <div
        // dynamic-style: column count comes from the chart's series
        style={{ display: "grid", gap: "var(--space-2)" }}
      />
    );`,
    `const x = (
      <>
        {/* dynamic-style: measured offset */}
        <div style={{ top: 12 }} />
      </>
    );`,
  ],
  invalid: [
    {
      code: `const x = <div style={{ display: "flex", gap: "var(--space-2)" }} />;`,
      errors: [{ messageId: "inlineStyle", data: { properties: "display, gap" } }],
    },
    {
      code: `const x = <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--text-secondary)" }} />;`,
      errors: [{ messageId: "inlineStyle", data: { properties: "margin, fontSize, color" } }],
    },
    {
      code: `const x = <div style={{ width: 24, height: -1, minWidth: \`200px\` }} />;`,
      errors: [{ messageId: "inlineStyle", data: { properties: "width, height, minWidth" } }],
    },
    {
      code: `const x = <span style={{ fontWeight: active ? 600 : 400, cursor: "pointer" }} />;`,
      errors: [{ messageId: "inlineStyle", data: { properties: "fontWeight" } }],
    },
    {
      code: `const x = <span style={{ "paddingLeft": "4px" }} />;`,
      errors: [{ messageId: "inlineStyle" }],
    },
    {
      // Hoisting the object into a const doesn't hide it.
      code: `const stack = { display: "flex", flexDirection: "column" } as const;
        const x = <div style={stack} />;`,
      errors: [{ messageId: "inlineStyle", data: { properties: "display, flexDirection" } }],
    },
    {
      // The comment must say why, and sit on the line right before.
      code: `const x = (
        <div
          // dynamic-style:
          style={{ display: "flex" }}
        />
      );`,
      errors: [{ messageId: "inlineStyle" }],
    },
    {
      code: `// dynamic-style: too far away

        const x = <div style={{ display: "flex" }} />;`,
      errors: [{ messageId: "inlineStyle" }],
    },
  ],
});

ruleTester.run("no-arbitrary-tailwind", noArbitraryTailwind, {
  valid: [
    `const x = <div className="flex gap-2 p-4 text-sm" />;`,
    `const x = <div className={cn("w-full", active && "text-accent")} />;`,
    // Not a class name.
    `const x = <div title="text-[13px]" />;`,
    `const s = "p-[3px]";`,
  ],
  invalid: [
    {
      code: `const x = <div className="text-[13px]" />;`,
      errors: [{ messageId: "arbitraryValue" }],
    },
    {
      code: `const x = <div className="flex p-[3px]" />;`,
      errors: [{ messageId: "arbitraryValue" }],
    },
    {
      code: `const x = <div className="md:gap-[7px]" />;`,
      errors: [{ messageId: "arbitraryValue" }],
    },
    { code: `const x = <div className="-mt-[2px]" />;`, errors: [{ messageId: "arbitraryValue" }] },
    {
      code: `const x = <div className="w-[calc(100%-1rem)]" />;`,
      errors: [{ messageId: "arbitraryValue" }],
    },
    { code: `const x = <div className="bg-[#fff]" />;`, errors: [{ messageId: "arbitraryValue" }] },
    {
      code: 'const x = <div className={`flex ${open ? "h-[40px]" : ""}`} />;',
      errors: [{ messageId: "arbitraryValue" }],
    },
    {
      code: `const c = clsx("grid", "grid-cols-[1fr_2fr]");`,
      errors: [{ messageId: "arbitraryValue" }],
    },
    {
      code: `const x = <Card bodyClassName="max-w-[60ch]" />;`,
      errors: [{ messageId: "arbitraryValue" }],
    },
  ],
});

ruleTester.run("no-bare-timestamp", noBareTimestamp, {
  valid: [
    `const x = <Timestamp iso={job.createdAt} />;`,
    // Strings: tooltips, descriptions and variables are not rendered text nodes.
    `const x = <Badge title={formatDateTime(at)}>Delivered</Badge>;`,
    "const x = <Badge title={`Delivered ${formatDateTime(at)}`}>Delivered</Badge>;",
    "const hint = `Last changed ${formatDateTime(at)}.`;",
    `function label(at) { return formatDateTime(at); }`,
    `const x = <span>{format(at)}</span>;`,
  ],
  invalid: [
    {
      code: `const x = <span className="list-text">{formatDateTime(job.createdAt)}</span>;`,
      errors: [{ messageId: "bareTimestamp" }],
    },
    {
      code: `const x = <Fact label="Enrolled">{formatDateTime(agent.createdAt)}</Fact>;`,
      errors: [{ messageId: "bareTimestamp" }],
    },
    {
      code: `const x = <>Revoked {at ? formatDateTime(at) : "never"}</>;`,
      errors: [{ messageId: "bareTimestamp" }],
    },
    {
      code: "const x = <p>{`Checked ${formatDateTime(at)}`}</p>;",
      errors: [{ messageId: "bareTimestamp" }],
    },
    {
      code: `const x = <span>{formatRelative(at, now)}</span>;`,
      errors: [{ messageId: "bareTimestamp" }],
    },
    {
      code: `const rows = items.map((i) => <td key={i.id}>{formatDateTime(i.at)}</td>);`,
      errors: [{ messageId: "bareTimestamp" }],
    },
  ],
});
