import { IconCopy, IconRefresh, IconTrash } from "@tabler/icons-react";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Toolbar } from "./toolbar.js";

const noop = () => {};

describe("Toolbar", () => {
  it("is a named toolbar with up to two actions in one group plus a More actions button", () => {
    render(
      <Toolbar
        label="Run actions"
        actions={[
          { label: "Rerun", icon: IconRefresh, onSelect: noop },
          { label: "Copy ID", icon: IconCopy, onSelect: noop },
        ]}
        menu={[{ label: "Delete run", icon: IconTrash, onSelect: noop, destructive: true }]}
      />,
    );
    const toolbar = screen.getByRole("toolbar", { name: "Run actions" });
    const group = toolbar.querySelector(".or-toolbar__group");
    expect(group?.querySelectorAll("button")).toHaveLength(2);
    const more = screen.getByRole("button", { name: "More actions" });
    expect(group?.contains(more)).toBe(false);
    expect(more.getAttribute("aria-haspopup")).toBe("menu");
  });

  it("runs actions and opens the menu from More actions", async () => {
    const user = userEvent.setup();
    const onRerun = vi.fn();
    render(
      <Toolbar
        label="Run actions"
        actions={[{ label: "Rerun", icon: IconRefresh, onSelect: onRerun }]}
        menu={[{ label: "Copy ID", onSelect: noop }]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Rerun" }));
    expect(onRerun).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "More actions" }));
    expect(await screen.findByRole("menuitem", { name: "Copy ID" })).toBeTruthy();
  });

  it("is one tab stop and Left/Right move focus between its buttons", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Toolbar
          label="Run actions"
          actions={[
            { label: "Rerun", icon: IconRefresh, onSelect: noop },
            { label: "Copy ID", icon: IconCopy, onSelect: noop },
          ]}
          menu={[{ label: "Delete run", onSelect: noop, destructive: true }]}
        />
        <button type="button">After</button>
      </>,
    );
    const rerun = screen.getByRole("button", { name: "Rerun" });
    const copy = screen.getByRole("button", { name: "Copy ID" });
    const more = screen.getByRole("button", { name: "More actions" });

    await user.tab();
    expect(document.activeElement).toBe(rerun);
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(copy);
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(more);
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(rerun);
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(more);
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(rerun);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(more);
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(copy);

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "After" }));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(copy);
  });

  it("disables actions and skips them in arrow navigation", async () => {
    const user = userEvent.setup();
    const onRerun = vi.fn();
    render(
      <Toolbar
        label="Run actions"
        actions={[
          { label: "Rerun", icon: IconRefresh, onSelect: onRerun, disabled: true },
          { label: "Copy ID", icon: IconCopy, onSelect: noop },
        ]}
        menu={[{ label: "Delete run", onSelect: noop, destructive: true }]}
      />,
    );
    const rerun = screen.getByRole("button", { name: "Rerun" }) as HTMLButtonElement;
    expect(rerun.disabled).toBe(true);
    await user.click(rerun);
    expect(onRerun).not.toHaveBeenCalled();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Copy ID" }));
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "More actions" }));
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Copy ID" }));
  });

  it("omits the group or the menu when it has none", () => {
    const { rerender } = render(
      <Toolbar label="Run actions" menu={[{ label: "Copy ID", onSelect: noop }]} />,
    );
    expect(document.querySelector(".or-toolbar__group")).toBeNull();
    expect(screen.getByRole("button", { name: "More actions" })).toBeTruthy();
    rerender(
      <Toolbar
        label="Run actions"
        actions={[{ label: "Rerun", icon: IconRefresh, onSelect: noop }]}
      />,
    );
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
  });

  it("accepts at most three primary actions (typecheck)", () => {
    const action = { label: "Rerun", icon: IconRefresh, onSelect: noop };
    // @ts-expect-error -- a fourth primary action belongs in the ⋯ menu
    const element = <Toolbar label="Run actions" actions={[action, action, action, action]} />;
    expect(element).toBeTruthy();
  });

  it("draws a solid action, a tooltip and a disabled reason that stays focusable", async () => {
    const user = userEvent.setup();
    const onStart = vi.fn();
    render(
      <Toolbar
        label="Work item actions"
        actions={[
          {
            label: "Start epic",
            icon: IconRefresh,
            onSelect: onStart,
            solid: true,
            tooltip: "Starts when SOC-398 is done",
          },
          {
            label: "Triage now",
            icon: IconCopy,
            onSelect: noop,
            disabled: true,
            disabledReason: "Om is triaging SOC-412",
          },
          { label: "Share review link", icon: IconCopy, onSelect: noop },
        ]}
      />,
    );
    const start = screen.getByRole("button", { name: "Start epic" });
    expect(start.className).toContain("or-icon-btn--solid");
    expect(start.className).toContain("or-toolbar__button--solid");
    await user.hover(start);
    expect((await screen.findByRole("tooltip")).textContent).toContain(
      "Starts when SOC-398 is done",
    );
    await user.click(start);
    expect(onStart).toHaveBeenCalledTimes(1);
    const triage = screen.getByRole("button", { name: "Triage now" });
    expect(triage.getAttribute("aria-disabled")).toBe("true");
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(triage);
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Share review link" }));
  });
});
