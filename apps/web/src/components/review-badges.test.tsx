import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SeverityCounts } from "./review-badges";

const counts = { critical: 2, high: 0, medium: 5, low: 1, info: 3 };

describe("SeverityCounts", () => {
  it("lists non-zero severities on one line, most severe first, with mono counts", () => {
    const html = renderToStaticMarkup(<SeverityCounts counts={counts} />);
    expect(html).toMatch(/^<span class="severity-counts">/);
    expect(html.match(/<span class="text-numeric">\d+<\/span>/g)).toEqual([
      '<span class="text-numeric">2</span>',
      '<span class="text-numeric">5</span>',
      '<span class="text-numeric">1</span>',
      '<span class="text-numeric">3</span>',
    ]);
    expect(html).not.toContain("high");
    for (const severity of ["critical", "medium", "low", "info"]) {
      expect(html).toContain(`severity-${severity}`);
    }
  });

  it("shows only the requested severities, and nothing when none are present", () => {
    const html = renderToStaticMarkup(
      <SeverityCounts counts={counts} only={["critical", "high"]} />,
    );
    expect(html).toContain('<span class="sr-only">critical</span>');
    expect(html).not.toContain("medium");
    expect(
      renderToStaticMarkup(
        <SeverityCounts counts={{ ...counts, critical: 0 }} only={["critical", "high"]} />,
      ),
    ).toBe("");
  });
});
