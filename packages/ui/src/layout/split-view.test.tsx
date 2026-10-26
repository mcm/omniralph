import { act, render, renderHook, screen, within } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SPLIT_WIDE_MIN_WIDTH, SplitView, useSplitWide } from "./split-view.js";

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
