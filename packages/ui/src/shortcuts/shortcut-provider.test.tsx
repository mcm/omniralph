import { fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "../actions/button.js";
import { ConfirmDialog } from "../actions/confirm-dialog.js";
import { UiProvider, type LinkProps } from "../provider/ui-provider.js";
import type { ShortcutDefinition } from "./definitions.js";
import {
  ShortcutProvider,
  useKeyShortcuts,
  useShortcut,
  type ShortcutDefinitions,
} from "./shortcut-provider.js";

const DEFINITIONS = {
  listNext: { key: "j", label: "Next item", group: "lists", repeat: true },
  listPrevious: { key: "k", label: "Previous item", group: "lists", repeat: true },
  listOpen: { key: "o", label: "Open the focused item", group: "lists" },
  back: { key: "u", label: "Back to the list", group: "lists" },
  done: { key: "e", label: "Done", group: "inbox" },
  search: { key: "k", mod: true, label: "Search", group: "goTo" },
  close: { key: "Escape", label: "Close", group: "panels", allowInFields: true },
} satisfies ShortcutDefinitions & Record<string, ShortcutDefinition>;

function Bound({
  id,
  onRun,
  enabled,
  label,
}: {
  id: string;
  onRun: () => void;
  enabled?: boolean;
  label?: string;
}) {
  useShortcut(id, onRun, { enabled });
  const keys = useKeyShortcuts(id);
  return (
    <button type="button" aria-keyshortcuts={keys} onClick={onRun}>
      {label ?? id}
    </button>
  );
}

function renderWith(children: ReactNode, platform: "apple" | "other" = "other") {
  return render(
    <ShortcutProvider definitions={DEFINITIONS} platform={platform}>
      {children}
    </ShortcutProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ShortcutProvider", () => {
  it("runs the enabled handler of the pressed action, and marks the key handled", async () => {
    const done = vi.fn();
    const search = vi.fn();
    renderWith(
      <>
        <Bound id="done" onRun={done} />
        <Bound id="search" onRun={search} />
      </>,
      "apple",
    );
    const user = userEvent.setup();
    await user.keyboard("e");
    expect(done).toHaveBeenCalledTimes(1);
    await user.keyboard("{Meta>}k{/Meta}");
    expect(search).toHaveBeenCalledTimes(1);
    // Ctrl+K isn't Mod+K on an Apple platform.
    await user.keyboard("{Control>}k{/Control}");
    expect(search).toHaveBeenCalledTimes(1);
    const event = new KeyboardEvent("keydown", { key: "e", bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("gives the control its key in ARIA form, for the platform", () => {
    renderWith(<Bound id="search" onRun={() => {}} />, "other");
    expect(screen.getByRole("button", { name: "search" }).getAttribute("aria-keyshortcuts")).toBe(
      "Control+K",
    );
  });

  it("does nothing for a disabled control, or after it unmounts", async () => {
    const done = vi.fn();
    const { rerender } = renderWith(<Bound id="done" onRun={done} enabled={false} />);
    const user = userEvent.setup();
    await user.keyboard("e");
    expect(done).not.toHaveBeenCalled();
    rerender(
      <ShortcutProvider definitions={DEFINITIONS} platform="other">
        <Bound id="done" onRun={done} />
      </ShortcutProvider>,
    );
    await user.keyboard("e");
    expect(done).toHaveBeenCalledTimes(1);
    rerender(<ShortcutProvider definitions={DEFINITIONS} platform="other" />);
    await user.keyboard("e");
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("ignores handled, composing and repeated key events", () => {
    const done = vi.fn();
    const next = vi.fn();
    renderWith(
      <>
        <Bound id="done" onRun={done} />
        <Bound id="listNext" onRun={next} />
      </>,
    );
    const handled = new KeyboardEvent("keydown", { key: "e", bubbles: true, cancelable: true });
    handled.preventDefault();
    document.body.dispatchEvent(handled);
    fireEvent.keyDown(document.body, { key: "e", isComposing: true });
    fireEvent.keyDown(document.body, { key: "e", repeat: true });
    expect(done).not.toHaveBeenCalled();
    // Next item repeats while the key is held.
    fireEvent.keyDown(document.body, { key: "j", repeat: true });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("ignores keys typed in a field, except Close", async () => {
    const done = vi.fn();
    const close = vi.fn();
    renderWith(
      <>
        <input aria-label="Title" />
        <input type="checkbox" aria-label="Pick" />
        <Bound id="done" onRun={done} />
        <Bound id="close" onRun={close} />
      </>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("textbox", { name: "Title" }));
    await user.keyboard("e");
    expect(done).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("e");
    await user.keyboard("{Escape}");
    expect(close).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("checkbox", { name: "Pick" }));
    await user.keyboard("e");
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("fires nothing while a dialog is open, Escape included", async () => {
    const done = vi.fn();
    const close = vi.fn();
    function WithDialog() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <Bound id="done" onRun={done} />
          <Bound id="close" onRun={close} />
          <ConfirmDialog
            open={open}
            onOpenChange={setOpen}
            title="Stop this run?"
            description="Om stops working on it."
            confirmLabel="Stop run"
            onConfirm={() => {}}
          />
        </>
      );
    }
    renderWith(<WithDialog />);
    await screen.findByRole("alertdialog");
    const user = userEvent.setup();
    await user.keyboard("e");
    expect(done).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(close).not.toHaveBeenCalled();
    await user.keyboard("e");
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("runs the most recently mounted of two enabled handlers, and reports the conflict", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = vi.fn();
    const second = vi.fn();
    render(
      <ShortcutProvider definitions={DEFINITIONS} platform="other" reportConflicts>
        <Bound id="done" onRun={first} label="First" />
        <Bound id="done" onRun={second} label="Second" />
      </ShortcutProvider>,
    );
    fireEvent.keyDown(document.body, { key: "e" });
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('"done"'));
  });

  it("leaves a key unhandled when its handler returns false", () => {
    renderWith(<Bound id="done" onRun={() => false as unknown as void} />);
    const event = new KeyboardEvent("keydown", { key: "e", bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("does nothing outside a provider", () => {
    const done = vi.fn();
    render(<Bound id="done" onRun={done} />);
    fireEvent.keyDown(document.body, { key: "e" });
    expect(done).not.toHaveBeenCalled();
    expect(screen.getByRole("button").getAttribute("aria-keyshortcuts")).toBeNull();
  });

  it("renders nothing of its own", () => {
    const { container } = renderWith(<Button>Only</Button>);
    expect(container.innerHTML).toBe(
      '<button type="button" class="or-btn or-btn--outline or-btn--md">Only</button>',
    );
  });
});

describe("list keys", () => {
  const navigate = vi.fn();
  const opened: string[] = [];
  function TestLink({ href, onClick, ...props }: LinkProps) {
    return (
      <a
        {...props}
        href={href}
        onClick={(event) => {
          event.preventDefault();
          opened.push(href);
          onClick?.(event);
        }}
      />
    );
  }

  function rows(ids: string[], options: { current?: string; hidden?: string } = {}) {
    return (
      <ul data-or-row-list="">
        {ids.map((id) => (
          <li key={id} aria-current={options.current === id ? "true" : undefined}>
            <a
              data-or-row-link=""
              href={`/items/${id}`}
              hidden={options.hidden === id}
              onClick={(event) => {
                event.preventDefault();
                opened.push(`/items/${id}`);
              }}
            >
              {id}
            </a>
          </li>
        ))}
      </ul>
    );
  }

  function renderList(children: ReactNode) {
    navigate.mockReset();
    opened.length = 0;
    return render(
      <UiProvider linkComponent={TestLink} navigate={navigate}>
        <ShortcutProvider definitions={DEFINITIONS} platform="other">
          <button type="button">Elsewhere</button>
          <main>{children}</main>
        </ShortcutProvider>
      </UiProvider>,
    );
  }

  const link = (name: string) => screen.getByRole("link", { name });

  it("moves focus through the row links, stopping at the ends", async () => {
    renderList(rows(["a", "b", "c"]));
    const user = userEvent.setup();
    await user.keyboard("j");
    expect(document.activeElement).toBe(link("a"));
    await user.keyboard("jj");
    expect(document.activeElement).toBe(link("c"));
    await user.keyboard("j");
    expect(document.activeElement).toBe(link("c"));
    await user.keyboard("kkk");
    expect(document.activeElement).toBe(link("a"));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("starts from the current row when focus is outside the list", async () => {
    renderList(rows(["a", "b", "c"], { current: "b" }));
    const user = userEvent.setup();
    screen.getByRole("button", { name: "Elsewhere" }).focus();
    await user.keyboard("j");
    expect(document.activeElement).toBe(link("c"));
    screen.getByRole("button", { name: "Elsewhere" }).focus();
    await user.keyboard("k");
    expect(document.activeElement).toBe(link("a"));
  });

  it("skips hidden row links (a DataTable's other layout)", async () => {
    renderList(rows(["a", "b", "c"], { hidden: "b" }));
    const user = userEvent.setup();
    await user.keyboard("jj");
    expect(document.activeElement).toBe(link("c"));
  });

  it("moves within the list holding focus, else the first one in main", async () => {
    renderList(
      <>
        {rows(["a", "b"])}
        <ul data-or-row-list="">
          <li>
            <a data-or-row-link="" href="/x">
              x
            </a>
          </li>
          <li>
            <a data-or-row-link="" href="/y">
              y
            </a>
          </li>
        </ul>
      </>,
    );
    const user = userEvent.setup();
    link("x").focus();
    await user.keyboard("j");
    expect(document.activeElement).toBe(link("y"));
    screen.getByRole("button", { name: "Elsewhere" }).focus();
    await user.keyboard("j");
    expect(document.activeElement).toBe(link("a"));
  });

  it("moves across nested lists as one (the outermost)", async () => {
    renderList(
      <div data-or-row-list="">
        {rows(["a"])}
        {rows(["b"])}
      </div>,
    );
    const user = userEvent.setup();
    link("a").focus();
    await user.keyboard("j");
    expect(document.activeElement).toBe(link("b"));
  });

  it("opens the row it moves to, with a history replace, when the list opens on move", async () => {
    renderList(<section data-or-open-on-move="">{rows(["a", "b"])}</section>);
    const user = userEvent.setup();
    await user.keyboard("jj");
    expect(navigate).toHaveBeenLastCalledWith("/items/b", { replace: true });
    expect(navigate).toHaveBeenCalledTimes(2);
    // At the end nothing moves, so nothing opens.
    await user.keyboard("j");
    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it("opens the focused row with o, and only from a row link", async () => {
    renderList(rows(["a", "b"]));
    const user = userEvent.setup();
    await user.keyboard("o");
    expect(opened).toEqual([]);
    await user.keyboard("jo");
    expect(opened).toEqual(["/items/a"]);
  });

  it("does nothing without a list", async () => {
    renderList(<p>No rows</p>);
    const event = new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
