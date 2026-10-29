import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it } from "vitest";
import { Sheet } from "../surfaces/sheet.js";
import { Button } from "./button.js";
import { ConfirmDialog } from "./confirm-dialog.js";
import { Menu } from "./menu.js";

/** A ⋯ menu whose item opens a dialog, as Fleet's "Revoke agent…" does. */
function MenuOpensDialog({ kind }: { kind: "confirm" | "sheet" }) {
  const [open, setOpen] = useState(false);
  return (
    <main>
      <Button>Before</Button>
      <Menu
        trigger={<Button>More actions</Button>}
        items={[{ label: "Revoke agent…", destructive: true, onSelect: () => setOpen(true) }]}
      />
      {kind === "confirm" ? (
        <ConfirmDialog
          open={open}
          onOpenChange={setOpen}
          title="Revoke agent?"
          description="It stops working."
          confirmLabel="Revoke"
          destructive
          onConfirm={() => {}}
        />
      ) : (
        <Sheet open={open} onOpenChange={setOpen} title="Revoke agent">
          <p>Body</p>
        </Sheet>
      )}
    </main>
  );
}

describe("menu and dialog focus", () => {
  it("leaves the page outside an open menu un-hidden, so nothing focusable sits under aria-hidden", async () => {
    const user = userEvent.setup();
    render(<MenuOpensDialog kind="confirm" />);
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await screen.findByRole("menu");
    expect(screen.getByRole("main").closest("[aria-hidden]")).toBeNull();
    expect(screen.getByRole("button", { name: "Before" })).toBeDefined();
  });

  it("returns focus to the menu's trigger when a menu item opens a ConfirmDialog and Escape closes it", async () => {
    const user = userEvent.setup();
    render(<MenuOpensDialog kind="confirm" />);
    const trigger = screen.getByRole("button", { name: "More actions" });
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: "Revoke agent…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("returns focus to the menu's trigger when a menu item opens a Sheet and Escape closes it", async () => {
    const user = userEvent.setup();
    render(<MenuOpensDialog kind="sheet" />);
    const trigger = screen.getByRole("button", { name: "More actions" });
    await user.click(trigger);
    await user.keyboard("{ArrowDown}{Enter}");
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("returns focus to `returnFocus` when the sheet opened without a control (from a link)", async () => {
    function OpenedFromLink() {
      const [open, setOpen] = useState(true);
      const add = useRef<HTMLButtonElement>(null);
      return (
        <main>
          <Button ref={add} onClick={() => setOpen(true)}>
            Add repo
          </Button>
          <Sheet open={open} onOpenChange={setOpen} title="Add repos" returnFocus={add}>
            <p>Body</p>
          </Sheet>
        </main>
      );
    }
    const user = userEvent.setup();
    render(<OpenedFromLink />);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add repo" }));
  });
});
