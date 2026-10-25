import { act, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearToasts, getToasts, MAX_TOASTS, toast, TOAST_DURATIONS } from "./toast-store.js";
import { Toaster } from "./toaster.js";

afterEach(() => {
  act(() => clearToasts());
  vi.useRealTimers();
});

function show(message: string, options?: Parameters<typeof toast>[1]) {
  act(() => {
    toast(message, options);
  });
}

function toastOf(message: string): HTMLElement {
  return screen.getByText(message).closest(".or-toast") as HTMLElement;
}

describe("Toaster", () => {
  it("renders in a region named Notifications", () => {
    render(<Toaster />);
    expect(screen.getByRole("region", { name: "Notifications" })).toBeTruthy();
  });

  it("announces success, info and warning politely and danger as an alert", () => {
    render(<Toaster />);
    show("Saved");
    show("Already running", { variant: "info" });
    show("Saved, but offline", { variant: "warning" });
    expect(screen.getAllByRole("status").map((node) => node.textContent)).toEqual([
      "Saved",
      "Already running",
      "Saved, but offline",
    ]);
    expect(screen.queryByRole("alert")).toBeNull();

    show("Couldn't save", { variant: "danger" });
    expect(screen.getByRole("alert").textContent).toBe("Couldn't save");
  });

  it("draws a status dot in the variant's tone, never the accent", () => {
    render(<Toaster />);
    show("Saved");
    show("Already running", { variant: "info" });
    show("Offline", { variant: "warning" });
    const dots = () =>
      Array.from(document.querySelectorAll(".or-toast .or-dot")).map((dot) => dot.className);
    expect(dots()).toEqual([
      "or-dot or-dot--good",
      "or-dot or-dot--neutral",
      "or-dot or-dot--neutral",
    ]);
    show("Failed", { variant: "danger" });
    expect(dots().at(-1)).toBe("or-dot or-dot--fail");
    expect(document.querySelector(".or-dot--need")).toBeNull();
  });

  it("dismisses a toast with its Dismiss button", async () => {
    const user = userEvent.setup();
    render(<Toaster />);
    show("First");
    show("Second");
    const [first] = screen.getAllByRole("button", { name: "Dismiss" });
    await user.click(first!);
    expect(screen.queryByText("First")).toBeNull();
    expect(screen.getByText("Second")).toBeTruthy();
  });

  it("dismisses itself after 5 s, or 8 s for danger", () => {
    vi.useFakeTimers();
    render(<Toaster />);
    show("Saved");
    show("Failed", { variant: "danger" });
    act(() => vi.advanceTimersByTime(TOAST_DURATIONS.success - 1));
    expect(screen.getByText("Saved")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText("Saved")).toBeNull();
    expect(screen.getByText("Failed")).toBeTruthy();
    act(() => vi.advanceTimersByTime(TOAST_DURATIONS.danger - TOAST_DURATIONS.success));
    expect(screen.queryByText("Failed")).toBeNull();
  });

  it("honors a custom duration", () => {
    vi.useFakeTimers();
    render(<Toaster />);
    show("Copied", { duration: 1_000 });
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.queryByText("Copied")).toBeNull();
  });

  it("pauses the timer while hovered and resumes with the time left", () => {
    vi.useFakeTimers();
    render(<Toaster />);
    show("Saved");
    act(() => vi.advanceTimersByTime(3_000));
    fireEvent.mouseEnter(toastOf("Saved"));
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText("Saved")).toBeTruthy();
    fireEvent.mouseLeave(toastOf("Saved"));
    act(() => vi.advanceTimersByTime(1_999));
    expect(screen.getByText("Saved")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("pauses the timer while focused", () => {
    vi.useFakeTimers();
    render(<Toaster />);
    show("Failed", { variant: "danger" });
    const dismiss = screen.getByRole("button", { name: "Dismiss" });
    act(() => dismiss.focus());
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText("Failed")).toBeTruthy();
    act(() => dismiss.blur());
    act(() => vi.advanceTimersByTime(TOAST_DURATIONS.danger));
    expect(screen.queryByText("Failed")).toBeNull();
  });

  it("shows at most 3, pushing out the oldest first", () => {
    render(<Toaster />);
    for (const message of ["One", "Two", "Three", "Four"]) show(message);
    expect(MAX_TOASTS).toBe(3);
    expect(screen.getAllByRole("status").map((node) => node.textContent)).toEqual([
      "Two",
      "Three",
      "Four",
    ]);
  });

  it("shows toasts raised before any Toaster mounted once one mounts", () => {
    toast("Created Acme");
    expect(getToasts()).toHaveLength(1);
    render(<Toaster />);
    expect(screen.getByRole("status").textContent).toBe("Created Acme");
  });
});

describe("toast", () => {
  it("defaults to success and returns the toast's id", () => {
    const id = toast("Saved");
    expect(getToasts()).toEqual([
      { id, message: "Saved", variant: "success", duration: TOAST_DURATIONS.success },
    ]);
  });
});
