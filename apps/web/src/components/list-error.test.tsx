import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ListError, ListErrorRow } from "./list-error";

const css = readFileSync(path.join(__dirname, "../app/globals.css"), "utf8");

/** The declarations of `selector`'s rule in globals.css. */
function rule(selector: string): string {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
}

const error = "The story ran out of attempts: the integration tests need a GitLab instance.";

describe("ListErrorRow", () => {
  it("puts the reason in its own row spanning the table", () => {
    const html = renderToStaticMarkup(
      <table>
        <tbody>
          <ListErrorRow error={error} colSpan={8} />
        </tbody>
      </table>,
    );
    expect(html).toContain("list-error-row");
    expect(html).toContain('colSpan="8"');
    expect(html).toContain(`>${error}</span>`);
  });
});

describe("ListError", () => {
  it("renders the full text (clamped by CSS), not only a title", () => {
    const html = renderToStaticMarkup(<ListError error={error} />);
    expect(html).toContain(`>${error}</span>`);
    expect(html).not.toContain("title=");
  });

  it("clamps to two lines and unclamps when expanded", () => {
    expect(rule(".list-error")).toContain("-webkit-line-clamp: 2");
    expect(rule(".list-error-expanded")).toContain("-webkit-line-clamp: none");
  });
});
