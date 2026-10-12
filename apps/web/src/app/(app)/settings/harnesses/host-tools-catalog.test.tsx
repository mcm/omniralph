import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { HostToolsCatalog } from "./host-tools-catalog";

vi.mock("./actions", () => ({}));

describe("HostToolsCatalog", () => {
  it("lists the host tools with their descriptions and a delete button, and the add form", () => {
    const html = renderToStaticMarkup(
      <HostToolsCatalog
        hostTools={[
          { id: "1", name: "opengrep", description: null },
          { id: "2", name: "semgrep", description: "SAST scanner" },
        ]}
      />,
    );
    expect([...html.matchAll(/data-host-tool="([^"]+)"/g)].map((m) => m[1])).toEqual([
      "opengrep",
      "semgrep",
    ]);
    expect(html).toContain("SAST scanner");
    expect(html).toContain('aria-label="Delete opengrep"');
    expect(html).toContain('aria-label="Delete semgrep"');
    expect(html).toContain('aria-label="Add a host tool"');
  });

  it("shows an empty state and the add form without host tools", () => {
    const html = renderToStaticMarkup(<HostToolsCatalog hostTools={[]} />);
    expect(html).toContain("No host tools");
    expect(html).not.toContain("data-host-tool");
    expect(html).toContain("Add host tool");
  });
});
