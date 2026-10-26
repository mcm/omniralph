import { act, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UiProvider, type LinkProps } from "../provider/ui-provider.js";
import { SectionIndex } from "./section-index.js";
import { ACTIVE_SECTION_ROOT_MARGIN, useActiveSection } from "./use-active-section.js";

const SECTIONS = [
  { id: "reviews", label: "Reviews" },
  { id: "coding", label: "Coding" },
  { id: "ask", label: "Ask" },
] as const;

function Page({ onNavigate = () => {} }: { onNavigate?: (id: string) => void }) {
  return (
    <>
      <SectionIndex
        aria-label="Sections"
        sections={SECTIONS}
        active="reviews"
        onNavigate={onNavigate}
      />
      {SECTIONS.map((section) => (
        <section key={section.id} id={section.id}>
          <h2>{section.label}</h2>
        </section>
      ))}
    </>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SectionIndex", () => {
  it("renders a named nav of links to each section, the active one current", () => {
    render(<Page />);
    const nav = screen.getByRole("navigation", { name: "Sections" });
    const links = Array.from(nav.querySelectorAll("a"));
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Reviews", "#reviews"],
      ["Coding", "#coding"],
      ["Ask", "#ask"],
    ]);
    expect(screen.getByRole("link", { name: "Reviews" })).toHaveProperty("className", "or-tab");
    expect(screen.getByRole("link", { name: "Reviews" }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("link", { name: "Coding" }).hasAttribute("aria-current")).toBe(false);
    expect(nav.querySelector("ul")?.className).toContain("or-tabs");
  });

  it("renders its links through the UiProvider link component", () => {
    const seen: string[] = [];
    function AppLink(props: LinkProps) {
      seen.push(props.href);
      return <a data-app-link="" {...props} />;
    }
    render(
      <UiProvider linkComponent={AppLink}>
        <Page />
      </UiProvider>,
    );
    expect(seen).toEqual(["#reviews", "#coding", "#ask"]);
    expect(screen.getByRole("link", { name: "Ask" }).hasAttribute("data-app-link")).toBe(true);
  });

  it("on click, calls onNavigate, scrolls the section to the top and focuses its heading", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const scrolled: Array<[string, unknown]> = [];
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (
      this: HTMLElement,
      options?: boolean | ScrollIntoViewOptions,
    ) {
      scrolled.push([this.id, options]);
    });
    render(<Page onNavigate={onNavigate} />);

    await user.click(screen.getByRole("link", { name: "Coding" }));

    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("coding");
    expect(scrolled).toEqual([["coding", { block: "start" }]]);
    const heading = screen.getByRole("heading", { name: "Coding" });
    expect(document.activeElement).toBe(heading);
    expect(heading.getAttribute("tabindex")).toBe("-1");
    // The link's default (a hash change) is replaced by the scroll.
    expect(window.location.hash).toBe("");
  });

  it("works from the keyboard", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<Page onNavigate={onNavigate} />);
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Coding" }));
    await user.keyboard("{Enter}");
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("coding");
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Coding" }));
  });

  it("focuses the section itself when it has no heading", async () => {
    const user = userEvent.setup();
    render(
      <>
        <SectionIndex aria-label="Sections" sections={[{ id: "plain", label: "Plain" }]} />
        <div id="plain">Text</div>
      </>,
    );
    await user.click(screen.getByRole("link", { name: "Plain" }));
    expect(document.activeElement?.id).toBe("plain");
  });
});

type ObserverCallback = (entries: Array<Partial<IntersectionObserverEntry>>) => void;

/** A controllable IntersectionObserver: `report` delivers entries to the latest instance. */
function mockIntersectionObserver() {
  const instances: Array<{
    callback: ObserverCallback;
    options?: IntersectionObserverInit;
    observed: Element[];
    disconnected: boolean;
  }> = [];
  class FakeObserver {
    private readonly record;
    constructor(callback: ObserverCallback, options?: IntersectionObserverInit) {
      this.record = { callback, options, observed: [] as Element[], disconnected: false };
      instances.push(this.record);
    }
    observe(element: Element) {
      this.record.observed.push(element);
    }
    unobserve() {}
    disconnect() {
      this.record.disconnected = true;
    }
    takeRecords() {
      return [];
    }
  }
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  return {
    instances,
    report(changes: Record<string, boolean>) {
      const current = instances.at(-1)!;
      act(() =>
        current.callback(
          Object.entries(changes).map(([id, isIntersecting]) => ({
            target: document.getElementById(id)!,
            isIntersecting,
          })),
        ),
      );
    },
  };
}

function Observed({ ids }: { ids: string[] }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const active = useActiveSection(ids, rootRef);
  return (
    <div ref={rootRef} data-testid="root">
      <output>{active ?? "none"}</output>
      {["reviews", "coding", "ask"].map((id) => (
        <section key={id} id={id} />
      ))}
    </div>
  );
}

describe("useActiveSection", () => {
  it("observes each section against the scroll root's top band", () => {
    const observer = mockIntersectionObserver();
    render(<Observed ids={["reviews", "coding", "ask"]} />);
    const [instance] = observer.instances;
    expect(instance!.options).toMatchObject({
      root: screen.getByTestId("root"),
      rootMargin: ACTIVE_SECTION_ROOT_MARGIN,
    });
    expect(instance!.observed.map((element) => element.id)).toEqual(["reviews", "coding", "ask"]);
  });

  it("starts at the first section and follows the one nearest the top", () => {
    const observer = mockIntersectionObserver();
    render(<Observed ids={["reviews", "coding", "ask"]} />);
    const active = () => screen.getByRole("status").textContent;
    expect(active()).toBe("reviews");

    observer.report({ reviews: true, coding: true });
    expect(active()).toBe("reviews");

    observer.report({ reviews: false });
    expect(active()).toBe("coding");

    observer.report({ coding: false, ask: true });
    expect(active()).toBe("ask");

    // Nothing in the band (e.g. scrolled through a gap): the last answer stays.
    observer.report({ ask: false });
    expect(active()).toBe("ask");

    // Scrolling back up: the topmost section in the band wins.
    observer.report({ reviews: true, ask: true });
    expect(active()).toBe("reviews");
  });

  it("disconnects on unmount and reobserves when the sections change", () => {
    const observer = mockIntersectionObserver();
    const { rerender, unmount } = render(<Observed ids={["reviews", "coding", "ask"]} />);
    rerender(<Observed ids={["coding", "ask"]} />);
    expect(observer.instances[0]!.disconnected).toBe(true);
    expect(observer.instances[1]!.observed.map((element) => element.id)).toEqual(["coding", "ask"]);
    expect(screen.getByRole("status").textContent).toBe("coding");
    unmount();
    expect(observer.instances[1]!.disconnected).toBe(true);
  });
});
