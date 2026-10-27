import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MonoValue, monoValueTail } from "./mono-value";

const css = readFileSync(path.join(__dirname, "../app/globals.css"), "utf8");

/** The declarations of `selector`'s rule in globals.css. */
function rule(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
}

describe("monoValueTail", () => {
  it("keeps a path's file name, a merge request number or a ref whole", () => {
    expect(monoValueTail("apps/web/src/app/(app)/repositories/page.tsx")).toBe("/page.tsx");
    expect(monoValueTail("fixture-labs/platform/api!314")).toBe("/api!314");
    expect(monoValueTail("fixture-labs/control-panel#307")).toBe("/control-panel#307");
    expect(monoValueTail("fixture-labs/a-very-long-repository-name#3")).toBe("#3");
    expect(monoValueTail("builtin:reply-to-finding")).toBe(":reply-to-finding");
  });

  it("keeps the last characters of a value without separators", () => {
    expect(monoValueTail("0f3c2a1b9d8e7f6a")).toBe("8e7f6a");
    expect(monoValueTail("short")).toBe("");
  });
});

describe("MonoValue", () => {
  it("renders the value in mono on one line with the full value in its title", () => {
    const html = renderToStaticMarkup(<MonoValue value="fixture-labs/control-panel" />);
    expect(html).toBe(
      '<span class="mono-value text-numeric" title="fixture-labs/control-panel">' +
        '<span class="mono-value-head">fixture-labs</span>' +
        '<span class="mono-value-tail">/control-panel</span></span>',
    );
  });

  it("truncates at the end when asked, and takes a full value for a short form", () => {
    const html = renderToStaticMarkup(
      <MonoValue value="0f3c2a1b…3a4b" title="0f3c2a1b-0000-0000-0000-00000000" truncate="end" />,
    );
    expect(html).toContain('title="0f3c2a1b-0000-0000-0000-00000000"');
    expect(html).toContain('<span class="mono-value-head">0f3c2a1b…3a4b</span>');
    expect(html).not.toContain("mono-value-tail");
  });

  it("never wraps and ellipsizes the head, keeping the tail whole", () => {
    expect(rule(".mono-value")).toContain("white-space: nowrap");
    expect(rule(".mono-value-head")).toContain("text-overflow: ellipsis");
    expect(rule(".mono-value-tail")).toContain("flex-shrink: 0");
  });
});
