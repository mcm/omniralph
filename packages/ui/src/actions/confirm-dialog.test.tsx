import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./button.js";
import { ConfirmDialog, type ConfirmDialogProps } from "./confirm-dialog.js";

function Subject(props: Partial<ConfirmDialogProps> & { onConfirm: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      title="Delete repository?"
      description="Its runs and history are removed."
      confirmLabel="Delete repository"
      destructive
      trigger={<Button>Delete</Button>}
      {...props}
    />
  );
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Delete" }));
  return screen.findByRole("alertdialog");
}

describe("ConfirmDialog", () => {
  it("is an alertdialog named by its title and described by its description, with focus inside", async () => {
    const user = userEvent.setup();
    render(<Subject onConfirm={vi.fn()} />);
    const dialog = await openDialog(user);
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(screen.getByRole("alertdialog", { name: "Delete repository?" })).toBe(dialog);
    expect(document.getElementById(dialog.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Its runs and history are removed.",
    );
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    const confirm = screen.getByRole("button", { name: "Delete repository" });
    expect(confirm.classList).toContain("or-btn--danger");
  });

  it("draws a non-destructive confirm as a solid button", async () => {
    const user = userEvent.setup();
    render(<Subject onConfirm={vi.fn()} destructive={false} confirmLabel="Archive" />);
    await openDialog(user);
    expect(screen.getByRole("button", { name: "Archive" }).classList).toContain("or-btn--solid");
  });

  it("cancels on Escape and returns focus to the trigger without confirming", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Subject onConfirm={onConfirm} />);
    await openDialog(user);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("cancels from the Cancel button", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Subject onConfirm={onConfirm} cancelLabel="Keep it" />);
    await openDialog(user);
    await user.click(screen.getByRole("button", { name: "Keep it" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("makes the decision required when cancelLabel is null: no Cancel, Escape keeps it open", async () => {
    const user = userEvent.setup();
    render(
      <Subject onConfirm={vi.fn()} cancelLabel={null} destructive={false} confirmLabel="Go on" />,
    );
    const dialog = await openDialog(user);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Go on" }));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("alertdialog")).toBe(dialog);
  });

  it("calls onConfirm once and closes", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Subject onConfirm={onConfirm} />);
    await openDialog(user);
    const confirm = screen.getByRole("button", { name: "Delete repository" });
    await user.dblClick(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();

    await openDialog(user);
    await user.click(screen.getByRole("button", { name: "Delete repository" }));
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it("keeps confirm disabled until the typed text matches exactly", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Subject onConfirm={onConfirm} typedConfirmation="acme/web" />);
    await openDialog(user);
    const input = screen.getByRole("textbox", { name: "Type acme/web to confirm" });
    expect(document.activeElement).toBe(input);
    const confirm = screen.getByRole("button", { name: "Delete repository" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    await user.type(input, "acme/we");
    expect(confirm.disabled).toBe(true);
    await user.type(input, "{Enter}");
    expect(onConfirm).not.toHaveBeenCalled();
    await user.type(input, "b ");
    expect(confirm.disabled).toBe(true);
    await user.clear(input);
    await user.type(input, "ACME/WEB");
    expect(confirm.disabled).toBe(true);
    await user.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, "acme/web");
    expect(confirm.disabled).toBe(false);
    await user.type(input, "{Enter}");
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("clears the typed text each time it opens", async () => {
    const user = userEvent.setup();
    render(<Subject onConfirm={vi.fn()} typedConfirmation="acme/web" />);
    await openDialog(user);
    await user.type(screen.getByRole("textbox"), "acme");
    await user.keyboard("{Escape}");
    await openDialog(user);
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("");
  });
});
