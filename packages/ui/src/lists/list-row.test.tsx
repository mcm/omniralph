import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { IconArchive } from "@tabler/icons-react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { IconButton } from "../actions/icon-button.js";
import { UiProvider, type LinkProps } from "../provider/ui-provider.js";
import { RepoBadge } from "../refs/badges.js";
import { BrandMark } from "../refs/brand-mark.js";
import { ListRow, RowList, type ListRowProps } from "./list-row.js";
import { nestedInteractiveElements } from "./nesting.js";

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

function Row(props: Partial<Omit<ListRowProps, "mark">>) {
  const [checked, setChecked] = useState(false);
  return (
    <UiProvider linkComponent={RouterLink}>
      <RowList aria-label="Needs you">
        <ListRow
          href="/runs/r1"
          title="Fix the login redirect"
          kindLabel="Request · failed"
          tone="fail"
          time="4m"
          meta={<RepoBadge host="github" name="acme/web" />}
          select={{ checked, onChange: setChecked, label: "Select Fix the login redirect" }}
          actions={<IconButton icon={IconArchive} label="Archive" />}
          {...props}
        />
      </RowList>
    </UiProvider>
  );
}

describe("ListRow", () => {
  it("renders a list item in a named list, with a row link named by the title", () => {
    render(<Row />);
    const list = screen.getByRole("list", { name: "Needs you" });
    const row = within(list).getByRole("listitem");
    const link = within(row).getByRole("link", { name: "Fix the login redirect" });
    expect(link.getAttribute("href")).toBe("/runs/r1");
    expect(link.className).toContain("or-row__link");
    expect(within(row).getAllByRole("link")).toHaveLength(1);
    expect(within(row).getByRole("img", { name: "Request · failed" }).className).toContain(
      "or-dot--fail",
    );
    expect(within(row).getByText("Request · failed").getAttribute("aria-hidden")).toBe("true");
    expect(within(row).getByText("acme/web")).toBeTruthy();
  });

  it("keeps the checkbox and actions as siblings of the row link", () => {
    const { container } = render(<Row />);
    const link = screen.getByRole("link", { name: "Fix the login redirect" });
    const box = screen.getByRole("checkbox", { name: "Select Fix the login redirect" });
    const action = screen.getByRole("button", { name: "Archive" });
    expect(link.contains(box)).toBe(false);
    expect(link.contains(action)).toBe(false);
    expect(nestedInteractiveElements(container)).toEqual([]);
  });

  it("reports nested controls when there are some", () => {
    const { container } = render(
      <a href="/x">
        <button type="button">Inner</button>
      </a>,
    );
    expect(nestedInteractiveElements(container)).toEqual([screen.getByRole("button")]);
  });

  it("tabs through the checkbox, the row link, then the actions", async () => {
    const user = userEvent.setup();
    render(<Row />);
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("checkbox", { name: "Select Fix the login redirect" }),
    );
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("link", { name: "Fix the login redirect" }),
    );
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Archive" }));
  });

  it("starts at the row link without a checkbox", async () => {
    const user = userEvent.setup();
    render(<Row select={undefined} meta={undefined} />);
    expect(screen.queryByRole("checkbox")).toBeNull();
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("link", { name: "Fix the login redirect" }),
    );
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Archive" }));
  });

  it("toggles the checkbox without following the link, and follows it on a row link click", async () => {
    follow.mockClear();
    const user = userEvent.setup();
    render(<Row />);
    const box = screen.getByRole("checkbox", { name: "Select Fix the login redirect" });
    await user.click(box);
    expect((box as HTMLInputElement).checked).toBe(true);
    await user.click(box);
    expect((box as HTMLInputElement).checked).toBe(false);
    await user.click(screen.getByRole("button", { name: "Archive" }));
    expect(follow).not.toHaveBeenCalled();
    await user.click(screen.getByRole("link", { name: "Fix the login redirect" }));
    expect(follow).toHaveBeenCalledWith("/runs/r1");
  });

  it("marks the selected row with aria-current", () => {
    const { rerender } = render(<Row />);
    expect(screen.getByRole("listitem").getAttribute("aria-current")).toBeNull();
    rerender(<Row selected />);
    expect(screen.getByRole("listitem").getAttribute("aria-current")).toBe("true");
  });

  it("puts the time in a fixed-width mono slot and clamps the title", () => {
    render(<Row />);
    const row = screen.getByRole("listitem");
    const time = within(row).getByText("4m");
    expect(time.className).toContain("or-row__time");
    expect(time.className).toContain("or-mono");
    expect(within(row).getByText("Fix the login redirect").className).toBe("or-row__title");
  });

  it("keeps the time slot when there is no time", () => {
    render(<Row time={undefined} />);
    expect(screen.getByRole("listitem").querySelector(".or-row__time")).toBeTruthy();
  });

  it("leads with a mark instead of the dot and kind line when given one", () => {
    render(
      <UiProvider linkComponent={RouterLink}>
        <RowList aria-label="Ready to start">
          <ListRow
            href="/backlog/linear-1"
            title="Export invoices"
            mark={<BrandMark brand="linear" />}
            meta={<RepoBadge host="github" name="acme/web" />}
          />
        </RowList>
      </UiProvider>,
    );
    const row = screen.getByRole("listitem");
    expect(within(row).getByRole("link", { name: "Export invoices" })).toBeTruthy();
    const mark = within(row).getByRole("img", { name: "Linear" });
    expect(mark.parentElement?.className).toBe("or-row__mark");
    expect(row.querySelector(".or-row__dot")).toBeNull();
    expect(row.querySelector(".or-row__kind")).toBeNull();
  });
});
