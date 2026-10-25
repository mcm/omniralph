import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { IconButton } from "../actions/icon-button.js";
import { Checkbox } from "../controls/checkbox.js";
import { UiProvider, type LinkProps } from "../provider/ui-provider.js";
import { RepoBadge } from "../refs/badges.js";
import { StatusText } from "../status/status.js";
import { IconTrash } from "@tabler/icons-react";
import { DataTable, type DataTableColumn } from "./data-table.js";
import { nestedInteractiveElements } from "./nesting.js";

interface Run {
  id: string;
  title: string;
  repo: string;
  status: string;
  failed: boolean;
  duration: string;
  sha: string;
}

const runs: Run[] = [
  {
    id: "r1",
    title: "Fix login",
    repo: "acme/web",
    status: "Running",
    failed: false,
    duration: "4m",
    sha: "a1b2c3d",
  },
  {
    id: "r2",
    title: "Add billing",
    repo: "acme/api",
    status: "Failed",
    failed: true,
    duration: "12m",
    sha: "e4f5a6b",
  },
];

const columns: DataTableColumn<Run>[] = [
  {
    id: "status",
    header: "Status",
    cell: (run) => <StatusText tone={run.failed ? "fail" : "run"}>{run.status}</StatusText>,
    card: "status",
  },
  { id: "title", header: "Run", cell: (run) => run.title, card: "title" },
  { id: "repo", header: "Repository", cell: (run) => <RepoBadge host="github" name={run.repo} /> },
  { id: "sha", header: "Commit", cell: (run) => run.sha, card: "hidden", mono: true },
  {
    id: "duration",
    header: "Duration",
    cell: (run) => run.duration,
    card: "time",
    align: "end",
    mono: true,
  },
  {
    id: "select",
    header: "Select",
    cell: (run) => <Checkbox aria-label={`Select ${run.title}`} />,
    card: "meta",
  },
  {
    id: "actions",
    header: "Actions",
    cell: (run) => <IconButton icon={IconTrash} label={`Delete ${run.title}`} />,
    card: "hidden",
  },
];

function renderTable(props: Partial<Parameters<typeof DataTable<Run>>[0]> = {}) {
  return render(
    <DataTable
      rows={runs}
      getRowId={(run) => run.id}
      columns={columns}
      caption="Runs"
      getRowHref={(run) => `/runs/${run.id}`}
      {...props}
    />,
  );
}

describe("DataTable", () => {
  it("renders a real table with a visually hidden caption and column headers", () => {
    renderTable();
    const table = screen.getByRole("table", { name: "Runs" });
    const caption = table.querySelector("caption")!;
    expect(caption.textContent).toBe("Runs");
    expect(caption.className).toContain("or-sr-only");
    expect(table.closest(".or-tblwrap")).toBeTruthy();
    const headers = within(table).getAllByRole("columnheader");
    expect(headers.map((header) => header.textContent)).toEqual([
      "Status",
      "Run",
      "Repository",
      "Commit",
      "Duration",
      "Select",
      "Actions",
    ]);
    for (const header of headers) expect(header.getAttribute("scope")).toBe("col");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("a1b2c3d").className).toContain("or-mono");
    expect(within(rows[0]!).getByText("4m").className).toContain("or-tbl__cell--end");
  });

  it("renders the same rows as stacked cards: status and time, then title, then meta", () => {
    renderTable();
    const list = screen.getByRole("list", { name: "Runs" });
    expect(list.className).toContain("or-cards");
    const cards = within(list).getAllByRole("listitem");
    expect(cards).toHaveLength(2);
    const card = cards[1]!;
    const parts = Array.from(card.children).map((child) => child.className);
    expect(parts).toEqual(["or-cardrow__top", "or-cardrow__title", "or-cardrow__meta"]);
    const top = card.querySelector(".or-cardrow__top")!;
    expect(top.querySelector(".or-cardrow__status")!.textContent).toBe("Failed");
    expect(top.querySelector(".or-cardrow__time")!.textContent).toBe("12m");
    expect(top.querySelector(".or-cardrow__time")!.className).toContain("or-mono");
    expect(card.querySelector(".or-cardrow__title")!.textContent).toBe("Add billing");
    const meta = card.querySelector(".or-cardrow__meta")!;
    expect(meta.textContent).toContain("acme/api");
    expect(
      within(meta as HTMLElement).getByRole("checkbox", { name: "Select Add billing" }),
    ).toBeTruthy();
    // Hidden columns are left out of the card.
    expect(within(card).queryByText("e4f5a6b")).toBeNull();
    expect(within(card).queryByRole("button", { name: "Delete Add billing" })).toBeNull();
  });

  it("uses the first column as the title when none is marked", () => {
    render(
      <DataTable
        rows={runs}
        getRowId={(run) => run.id}
        columns={[
          { id: "title", header: "Run", cell: (run) => run.title },
          { id: "repo", header: "Repository", cell: (run) => run.repo },
        ]}
        caption="Runs"
      />,
    );
    const card = within(screen.getByRole("list", { name: "Runs" })).getAllByRole("listitem")[0]!;
    expect(card.querySelector(".or-cardrow__title")!.textContent).toBe("Fix login");
    expect(card.querySelector(".or-cardrow__meta")!.textContent).toBe("acme/web");
    expect(card.querySelector(".or-cardrow__top")).toBeNull();
    // Without getRowHref nothing is a link.
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("puts exactly one row link in each title cell and each card, through the link component", () => {
    const seen: string[] = [];
    function RouterLink(props: LinkProps) {
      seen.push(props.href);
      return <a {...props} data-router="" />;
    }
    render(
      <UiProvider linkComponent={RouterLink}>
        <DataTable
          rows={runs}
          getRowId={(run) => run.id}
          columns={columns}
          caption="Runs"
          getRowHref={(run) => `/runs/${run.id}`}
        />
      </UiProvider>,
    );
    const table = screen.getByRole("table", { name: "Runs" });
    for (const [index, row] of within(table).getAllByRole("row").slice(1).entries()) {
      const links = within(row).getAllByRole("link");
      expect(links).toHaveLength(1);
      expect(links[0]!.getAttribute("href")).toBe(`/runs/${runs[index]!.id}`);
      expect(links[0]!.hasAttribute("data-router")).toBe(true);
      expect(links[0]!.closest("td")!.className).toContain("or-tbl__title");
      expect(links[0]!.textContent).toBe(runs[index]!.title);
    }
    for (const [index, card] of within(screen.getByRole("list", { name: "Runs" }))
      .getAllByRole("listitem")
      .entries()) {
      const links = within(card).getAllByRole("link");
      expect(links).toHaveLength(1);
      expect(links[0]!.getAttribute("href")).toBe(`/runs/${runs[index]!.id}`);
      expect(links[0]!.hasAttribute("data-router")).toBe(true);
    }
    expect(seen).toEqual(expect.arrayContaining(["/runs/r1", "/runs/r2"]));
  });

  it("never nests a link, button or input inside a link or button", () => {
    const { container } = renderTable();
    expect(container.querySelectorAll("a").length).toBeGreaterThan(0);
    expect(container.querySelectorAll("button").length).toBeGreaterThan(0);
    expect(container.querySelectorAll("input").length).toBeGreaterThan(0);
    expect(nestedInteractiveElements(container)).toEqual([]);
  });

  it("keeps cell controls usable without following the row link", async () => {
    const user = userEvent.setup();
    const follow = vi.fn();
    function RouterLink({ onClick, ...props }: LinkProps) {
      return (
        <a
          {...props}
          onClick={(event) => {
            event.preventDefault();
            onClick?.(event);
            follow(props.href);
          }}
        />
      );
    }
    render(
      <UiProvider linkComponent={RouterLink}>
        <DataTable
          rows={runs}
          getRowId={(run) => run.id}
          columns={columns}
          caption="Runs"
          getRowHref={(run) => `/runs/${run.id}`}
        />
      </UiProvider>,
    );
    const table = screen.getByRole("table", { name: "Runs" });
    const box = within(table).getByRole("checkbox", { name: "Select Fix login" });
    await user.click(box);
    expect((box as HTMLInputElement).checked).toBe(true);
    expect(follow).not.toHaveBeenCalled();
    await user.click(within(table).getByRole("link", { name: "Fix login" }));
    expect(follow).toHaveBeenCalledWith("/runs/r1");
  });

  it("marks the selected row and card with aria-current", () => {
    renderTable({ selectedId: "r2" });
    const rows = within(screen.getByRole("table", { name: "Runs" }))
      .getAllByRole("row")
      .slice(1);
    expect(rows[0]!.getAttribute("aria-current")).toBeNull();
    expect(rows[1]!.getAttribute("aria-current")).toBe("true");
    const cards = within(screen.getByRole("list", { name: "Runs" })).getAllByRole("listitem");
    expect(cards[0]!.getAttribute("aria-current")).toBeNull();
    expect(cards[1]!.getAttribute("aria-current")).toBe("true");
  });

  it("tints rows whose tone is bad", () => {
    renderTable({ rowTone: (run) => (run.failed ? "bad" : undefined) });
    const rows = within(screen.getByRole("table", { name: "Runs" }))
      .getAllByRole("row")
      .slice(1);
    expect(rows[0]!.className).not.toContain("or-tbl__row--bad");
    expect(rows[1]!.className).toContain("or-tbl__row--bad");
    const cards = within(screen.getByRole("list", { name: "Runs" })).getAllByRole("listitem");
    expect(cards[0]!.className).not.toContain("or-cardrow--bad");
    expect(cards[1]!.className).toContain("or-cardrow--bad");
  });

  it("requires a caption", () => {
    // @ts-expect-error caption is required
    const element = <DataTable rows={runs} getRowId={(run) => run.id} columns={columns} />;
    expect(element).toBeTruthy();
  });
});
