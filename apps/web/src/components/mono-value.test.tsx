import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Timestamp } from "./list-table";
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
    expect(monoValueTail("fixture-labs/platform/api!314")).toBe("!314");
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

describe("Timestamp", () => {
  const iso = "2026-10-05T15:04:00.000Z";

  it("renders mono and on one line, in a table or inline in text", () => {
    expect(renderToStaticMarkup(<Timestamp iso={iso} />)).toMatch(
      /^<time dateTime="2026-10-05T15:04:00.000Z" class="list-time text-numeric">/,
    );
    expect(renderToStaticMarkup(<Timestamp iso={iso} inline />)).toMatch(
      /class="mono-time text-numeric"/,
    );
    expect(rule(".list-time")).toContain("white-space: nowrap");
    expect(rule(".mono-time")).toContain("white-space: nowrap");
  });

  it("shows a relative time with the exact one in its title", () => {
    const now = new Date(iso).getTime() + 5 * 60_000;
    const html = renderToStaticMarkup(<Timestamp iso={iso} now={now} />);
    expect(html).toContain(">5 min ago</time>");
    expect(html).toMatch(/title="[^"]+"/);
  });
});
