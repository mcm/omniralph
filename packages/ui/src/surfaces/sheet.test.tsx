import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "../actions/button.js";
import { Sheet } from "./sheet.js";

/** A page with a button that opens the sheet (no `trigger` prop: the app owns `open`). */
function Page() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button">Before</button>
      <button type="button" onClick={() => setOpen(true)}>
        Add repo
      </button>
      <Sheet
        title="Add repos"
        description="Pick the repos Om works on."
        open={open}
        onOpenChange={setOpen}
        footer={<Button onClick={() => setOpen(false)}>Done</Button>}
      >
        <label>
          Organization <input />
        </label>
      </Sheet>
    </>
  );
}

describe("Sheet", () => {
  it("is a modal dialog named by its title and described by its description", async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole("button", { name: "Add repo" }));
    const sheet = screen.getByRole("dialog", { name: "Add repos" });
    expect(sheet.className).toContain("or-sheet");
    expect(sheet.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(sheet.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Pick the repos Om works on.",
    );
    expect(within(sheet).getByRole("heading", { name: "Add repos" })).toBeTruthy();
    expect(within(sheet).getByLabelText("Organization")).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: "Done" })).toBeTruthy();
  });

  it("leaves out the description and footer when not given", () => {
    const errors = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(
      <Sheet title="Plain" open onOpenChange={() => {}}>
        Body
      </Sheet>,
    );
    const sheet = screen.getByRole("dialog", { name: "Plain" });
    expect(sheet.hasAttribute("aria-describedby")).toBe(false);
    expect(sheet.querySelector(".or-sheet__footer")).toBeNull();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("covers the page with a scrim that injects no style element, and closes on a scrim click", async () => {
    // The agent page's CSP refuses inline styles: opening a sheet must not need one.
    const user = userEvent.setup();
    render(<Page />);
    const styles = document.querySelectorAll("style").length;
    await user.click(screen.getByRole("button", { name: "Add repo" }));
    expect(screen.getByRole("dialog", { name: "Add repos" })).toBeTruthy();
    expect(document.querySelectorAll("style")).toHaveLength(styles);
    const scrim = document.querySelector(".or-sheet__scrim.or-scrim")!;
    expect(scrim.getAttribute("aria-hidden")).toBe("true");
    await user.click(scrim);
    expect(screen.queryByRole("dialog", { name: "Add repos" })).toBeNull();
    expect(document.querySelector(".or-scrim")).toBeNull();
  });

  it("closes on Escape and returns focus to the button that opened it", async () => {
    const user = userEvent.setup();
    render(<Page />);
    const opener = screen.getByRole("button", { name: "Add repo" });
    await user.click(opener);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('closes on its "Close" button and returns focus to the opener', async () => {
    const user = userEvent.setup();
    render(<Page />);
    const opener = screen.getByRole("button", { name: "Add repo" });
    await user.click(opener);
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
