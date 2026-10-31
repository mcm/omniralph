import type { MenuItem } from "@omniralph/ui";
import { describe, expect, it } from "vitest";
import { workItemHref, workItemLinkMenuItems } from "./work-item-links";

const links = (items: MenuItem[]) =>
  items.map((item) => (item === "separator" ? "—" : [item.label, item.href]));

describe("workItemLinkMenuItems", () => {
  it("pairs Open in Linear with the work item's Backlog page, which comes first", () => {
    expect(
      links(
        workItemLinkMenuItems({
          id: "linear-issue 42",
          url: "https://linear.app/acme/issue/TOOL-42",
        }),
      ),
    ).toEqual([
      ["Open work item", "/backlog/linear-issue%2042"],
      ["Open in Linear", "https://linear.app/acme/issue/TOOL-42"],
    ]);
  });

  it("offers only the links it knows", () => {
    expect(links(workItemLinkMenuItems({ id: null, url: "https://linear.app/x" }))).toEqual([
      ["Open in Linear", "https://linear.app/x"],
    ]);
    expect(links(workItemLinkMenuItems({ id: "linear-1", url: null }))).toEqual([
      ["Open work item", workItemHref("linear-1")],
    ]);
    expect(workItemLinkMenuItems(null)).toEqual([]);
  });
});
