import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataTable } from "../lists/data-table.js";
import { ScrollRegion } from "./scroll-region.js";

/** jsdom has no layout: give every element the content and box sizes of a scrolling box. */
function layout({ content, box }: { content: number; box: number }) {
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(content);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(box);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(20);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(20);
}

afterEach(() => vi.restoreAllMocks());

describe("ScrollRegion", () => {
  it("is a named, focusable group while its content overflows", () => {
    layout({ content: 900, box: 300 });
    render(
      <ScrollRegion as="pre" label="Prompt">
        a very long line
      </ScrollRegion>,
    );
    const region = screen.getByRole("group", { name: "Prompt" });
    expect(region.tagName).toBe("PRE");
    expect(region.tabIndex).toBe(0);
    region.focus();
    expect(document.activeElement).toBe(region);
  });

  it("is no tab stop and no group when everything fits", () => {
    layout({ content: 300, box: 300 });
    const { container } = render(<ScrollRegion label="Prompt">short</ScrollRegion>);
    const box = container.querySelector(".or-scroll-region")!;
    expect(screen.queryByRole("group")).toBeNull();
    expect(box.hasAttribute("tabindex")).toBe(false);
    expect(box.hasAttribute("aria-label")).toBe(false);
  });

  it("makes a DataTable that scrolls sideways focusable, named by its caption", () => {
    layout({ content: 1200, box: 600 });
    render(
      <DataTable
        caption="Storage"
        rows={[{ id: "a", name: "workspace" }]}
        getRowId={(row) => row.id}
        columns={[{ id: "name", header: "Name", cell: (row) => row.name }]}
      />,
    );
    const region = screen.getByRole("group", { name: "Storage" });
    expect(region.classList).toContain("or-tblwrap");
    expect(region.tabIndex).toBe(0);
    expect(region.querySelector("table")).not.toBeNull();
  });
});
