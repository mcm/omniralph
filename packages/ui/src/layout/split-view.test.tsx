import { act, cleanup, render, renderHook, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ListRow, RowList } from "../lists/list-row.js";
import { UiProvider, type LinkProps } from "../provider/ui-provider.js";
import { ShortcutProvider } from "../shortcuts/shortcut-provider.js";
import {
  SPLIT_WIDE_MIN_WIDTH,
  SplitView,
  useSplitDetailShown,
  useSplitWide,
} from "./split-view.js";

describe("SplitView", () => {
  it("renders the list and detail panes, named, with the view and fixed pane", () => {
    const { container } = render(
      <SplitView
        list={<h1>Inbox</h1>}
        detail={<h2>Fix the login</h2>}
        view="detail"
        listLabel="Inbox"
        backLink={{ label: "Inbox", href: "/?tab=problems" }}
      />,
    );
    const split = container.querySelector<HTMLElement>(".or-split")!;
    expect(split.dataset.view).toBe("detail");
    expect(split.dataset.fixed).toBe("list");
    const list = screen.getByRole("region", { name: "Inbox" });
    expect(within(list).getByRole("heading", { name: "Inbox" })).toBeTruthy();
    const detail = screen.getByRole("region", { name: "Details" });
    expect(within(detail).getByRole("heading", { name: "Fix the login" })).toBeTruthy();
    // The back link sits on the detail, before its content.
    const back = within(detail).getByRole("link", { name: "Inbox" });
    expect(back.textContent).toBe("‹ Inbox");
    expect(back.getAttribute("href")).toBe("/?tab=problems");
    expect(back.className).toBe("or-split__back");
    expect(detail.firstElementChild).toBe(back);
  });

  it("sets the list widths as custom properties, 340/300 by default", () => {
    const { container, rerender } = render(
      <SplitView list="List" detail={null} view="list" listLabel="Runs" />,
    );
    const split = () => container.querySelector<HTMLElement>(".or-split")!;
    expect(split().style.getPropertyValue("--or-split-wide")).toBe("340px");
    expect(split().style.getPropertyValue("--or-split-narrow")).toBe("300px");
    rerender(
      <SplitView
        list="List"
        detail={null}
        view="list"
        listLabel="Inbox"
        listWidth={{ wide: 400, narrow: 340 }}
      />,
    );
    expect(split().style.getPropertyValue("--or-split-wide")).toBe("400px");
    expect(split().style.getPropertyValue("--or-split-narrow")).toBe("340px");
  });

  it("gives the fixed width to the detail with fixedPane detail", () => {
    const { container } = render(
      <SplitView
        list="Table"
        detail="Panel"
        view="list"
        listLabel="Agents"
        detailLabel="Agent"
        fixedPane="detail"
      />,
    );
    expect(container.querySelector<HTMLElement>(".or-split")!.dataset.fixed).toBe("detail");
    expect(screen.getByRole("region", { name: "Agent" }).textContent).toBe("Panel");
  });

  it("renders no back link without one, and no shortcut hints", () => {
    render(<SplitView list="List" detail="Detail" view="detail" listLabel="Runs" />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(document.querySelector("kbd")).toBeNull();
  });
});

describe("SplitView ref", () => {
  it("is the size container", () => {
    let element: HTMLDivElement | null = null;
    render(
      <SplitView
        ref={(node) => {
          element = node;
        }}
        list="List"
        detail={null}
        view="list"
        listLabel="Runs"
      />,
    );
    expect(element).not.toBeNull();
    expect(element!.classList.contains("or-split")).toBe(true);
  });
});

describe("useSplitWide", () => {
  type Callback = (entries: { contentRect: { width: number } }[]) => void;
  const observers: {
    callback: Callback;
    observe: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }[] = [];

  afterEach(() => {
    vi.unstubAllGlobals();
    observers.length = 0;
  });

  function stubResizeObserver() {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = vi.fn();
        disconnect = vi.fn();
        constructor(callback: Callback) {
          observers.push({ callback, observe: this.observe, disconnect: this.disconnect });
        }
      },
    );
  }

  function useWide() {
    const ref = useRef<HTMLDivElement | null>(null);
    if (!ref.current) {
      ref.current = document.createElement("div");
      ref.current.getBoundingClientRect = () => ({ width: 600 }) as DOMRect;
    }
    return { wide: useSplitWide(ref), element: ref.current };
  }

  it("follows the container's width across 880 px", () => {
    stubResizeObserver();
    const { result, unmount } = renderHook(useWide);
    expect(result.current.wide).toBe(false);
    expect(observers).toHaveLength(1);
    expect(observers[0]!.observe).toHaveBeenCalledWith(result.current.element);

    act(() => observers[0]!.callback([{ contentRect: { width: SPLIT_WIDE_MIN_WIDTH } }]));
    expect(result.current.wide).toBe(true);
    act(() => observers[0]!.callback([{ contentRect: { width: SPLIT_WIDE_MIN_WIDTH - 1 } }]));
    expect(result.current.wide).toBe(false);
    act(() => observers[0]!.callback([{ contentRect: { width: 1400 } }]));
    expect(result.current.wide).toBe(true);

    unmount();
    expect(observers[0]!.disconnect).toHaveBeenCalled();
  });

  it("measures the element at once", () => {
    stubResizeObserver();
    const { result } = renderHook(() => {
      const ref = useRef<HTMLDivElement | null>(null);
      if (!ref.current) {
        ref.current = document.createElement("div");
        ref.current.getBoundingClientRect = () => ({ width: 1000 }) as DOMRect;
      }
      return useSplitWide(ref);
    });
    expect(result.current).toBe(true);
  });

  it("is false without an element", () => {
    stubResizeObserver();
    const { result } = renderHook(() => useSplitWide({ current: null }));
    expect(result.current).toBe(false);
    expect(observers).toHaveLength(0);
  });
});

describe("SplitView shortcuts", () => {
  const DEFINITIONS = {
    listNext: { key: "j", label: "Next item", group: "lists", repeat: true },
    listPrevious: { key: "k", label: "Previous item", group: "lists", repeat: true },
    listOpen: { key: "o", label: "Open the focused item", group: "lists" },
    back: { key: "u", label: "Back to the list", group: "lists" },
  } as const;
  const navigate = vi.fn();
  const followed: string[] = [];

  function TestLink({ href, onClick, ...props }: LinkProps) {
    return (
      <a
        {...props}
        href={href}
        onClick={(event) => {
          event.preventDefault();
          followed.push(href);
          onClick?.(event);
        }}
      />
    );
  }

  function DetailShown() {
    return <p>{useSplitDetailShown() ? "Detail shown" : "Detail hidden"}</p>;
  }

  function renderSplit(view: "list" | "detail", width: number) {
    navigate.mockReset();
    followed.length = 0;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ width } as DOMRect);
    return render(
      <UiProvider linkComponent={TestLink} navigate={navigate}>
        <ShortcutProvider definitions={DEFINITIONS} platform="other">
          <main>
            <SplitView
              list={
                <RowList aria-label="Runs">
                  <ListRow href="/runs/1" title="One" kindLabel="Epic · running" tone="run" />
                  <ListRow href="/runs/2" title="Two" kindLabel="Epic · running" tone="run" />
                </RowList>
              }
              detail={<DetailShown />}
              view={view}
              listLabel="Runs"
              backLink={{ label: "Runs", href: "/runs" }}
            />
          </main>
        </ShortcutProvider>
      </UiProvider>,
    );
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens the row a move lands on while both panes show", async () => {
    renderSplit("list", 1000);
    const user = userEvent.setup();
    await user.keyboard("jj");
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Two" }));
    expect(navigate).toHaveBeenLastCalledWith("/runs/2", { replace: true });
    expect(screen.getByText("Detail shown")).toBeTruthy();
    // Back has nothing to follow: the back link is hidden while both panes show.
    await user.keyboard("u");
    expect(followed).toEqual([]);
  });

  it("only moves focus in a single pane, and o opens the row", async () => {
    renderSplit("list", 600);
    const user = userEvent.setup();
    await user.keyboard("j");
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByText("Detail hidden")).toBeTruthy();
    await user.keyboard("o");
    expect(followed).toEqual(["/runs/1"]);
  });

  it("follows the back link with u while the detail shows alone", async () => {
    renderSplit("detail", 600);
    const user = userEvent.setup();
    await user.keyboard("u");
    expect(followed).toEqual(["/runs"]);
    expect(screen.getByText("Detail shown")).toBeTruthy();
  });
});

describe("SplitView's title", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderSplit(view: "list" | "detail", width: number) {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ width } as DOMRect);
    return render(
      <SplitView
        list={<h1>Inbox</h1>}
        detail={<h2>Fix the login</h2>}
        view={view}
        listLabel="Inbox"
        title="Inbox"
      />,
    );
  }

  const detail = () => screen.getByRole("region", { name: "Details" });

  it("is a visually hidden h1 in the detail pane while the detail shows alone", () => {
    renderSplit("detail", 600);
    const heading = within(detail()).getByRole("heading", { level: 1, name: "Inbox" });
    expect(heading.className).toBe("or-sr-only");
    // The detail's own title stays the h2 under it.
    expect(within(detail()).getByRole("heading", { level: 2, name: "Fix the login" })).toBeTruthy();
  });

  it("is left to the list while both panes show, or the list shows alone", () => {
    renderSplit("detail", SPLIT_WIDE_MIN_WIDTH);
    expect(within(detail()).queryByRole("heading", { level: 1 })).toBeNull();
    cleanup();
    renderSplit("list", 600);
    expect(within(detail()).queryByRole("heading", { level: 1 })).toBeNull();
  });
});
