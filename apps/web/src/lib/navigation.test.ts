import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isNavActive } from "@omniralph/ui";
import { IconChartBar, IconMessage } from "@tabler/icons-react";
import { describe, expect, it } from "vitest";
import { navItems, withNavIndicators } from "@/lib/navigation";

const APP_DIR = path.resolve(__dirname, "../app/(app)");

/** Every `page.tsx` under `src/app/(app)`, by the URL path it serves (route groups dropped). */
function appPages(dir = APP_DIR, segments: string[] = []): Map<string, string> {
  const pages = new Map<string, string>();
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      const next = /^\(.*\)$/.test(name) ? segments : [...segments, name];
      for (const [route, file] of appPages(full, next)) pages.set(route, file);
    } else if (name === "page.tsx") {
      pages.set(`/${segments.join("/")}`, full);
    }
  }
  return pages;
}

const pages = appPages();

/** Entries whose 2.0 page doesn't exist yet. */
const PAGES_TO_COME: string[] = [];

/** Pages no entry lights up. */
const UNLISTED_PAGES: string[] = [];

/** The page an `href` opens: a static match, else one through dynamic `[segments]`. */
function pageFor(href: string): string | undefined {
  const exact = pages.get(href);
  if (exact) return exact;
  const wanted = href.split("/");
  for (const [route, file] of pages) {
    const parts = route.split("/");
    if (
      parts.length === wanted.length &&
      parts.every((part, i) => part === wanted[i] || /^\[[^.\]]+\]$/.test(part))
    ) {
      return file;
    }
  }
  return undefined;
}

describe("navItems", () => {
  it("finds today's pages (sanity check)", () => {
    // Repos replaced the old repository pages.
    expect(pageFor("/repositories")).toBeUndefined();
    expect(pages.get("/repos")).toBeDefined();
    expect(pages.get("/settings/advanced/routing")).toBeDefined();
    expect(pages.get("/repos/[id]")).toBeDefined();
    expect(pageFor("/repos/abc")).toBe(pages.get("/repos/[id]"));
    expect(pageFor("/nowhere")).toBeUndefined();
  });

  it("points every entry at an existing page, except the pages later epics build", () => {
    for (const item of navItems) {
      if (PAGES_TO_COME.includes(item.href)) {
        expect(pageFor(item.href), item.href).toBeUndefined();
        continue;
      }
      const page = pageFor(item.href);
      expect(page, item.href).toBeDefined();
      expect(existsSync(page!)).toBe(true);
    }
  });

  it("lists Inbox, Runs, Backlog, Repos and Fleet, then Ask, Analytics and Settings at the bottom", () => {
    expect(
      navItems.map(({ id, label, href, placement, phone }) => ({
        id,
        label,
        href,
        placement,
        phone,
      })),
    ).toEqual([
      { id: "inbox", label: "Inbox", href: "/", placement: "main", phone: "tab" },
      { id: "runs", label: "Runs", href: "/runs", placement: "main", phone: "tab" },
      { id: "backlog", label: "Backlog", href: "/backlog", placement: "main", phone: "tab" },
      { id: "repos", label: "Repos", href: "/repos", placement: "main", phone: "drawer" },
      { id: "fleet", label: "Fleet", href: "/fleet", placement: "main", phone: "drawer" },
      { id: "ask", label: "Ask", href: "/ask", placement: "bottom", phone: "tab" },
      {
        id: "analytics",
        label: "Analytics",
        href: "/analytics",
        placement: "bottom",
        phone: "drawer",
      },
      {
        id: "settings",
        label: "Settings",
        href: "/settings",
        placement: "bottom",
        phone: "drawer",
      },
    ]);
  });

  it("orders the phone tab bar Inbox, Runs, Backlog, Ask", () => {
    expect(navItems.filter((item) => item.phone === "tab").map((item) => item.label)).toEqual([
      "Inbox",
      "Runs",
      "Backlog",
      "Ask",
    ]);
  });

  it("points Ask at /ask, first in the bottom group, lit for /ask, with the message icon and no indicator", () => {
    const bottom = navItems.filter((item) => item.placement === "bottom").map((item) => item.id);
    expect(bottom[0]).toBe("ask");
    const ask = navItems.find((item) => item.id === "ask")!;
    expect(ask).toMatchObject({ href: "/ask", activeFor: ["/ask"], placement: "bottom" });
    expect(ask.icon).toBe(IconMessage);
    expect(ask.indicator).toBeUndefined();
    expect(pages.get("/ask")).toBeDefined();
    // Nothing in Ask needs you: the live indicators never mark it.
    const marked = withNavIndicators(
      navItems,
      { needsYou: 3, problems: 1, running: 2 },
      { readyToStart: 1, needsRefining: 1, total: 2 },
      {
        fleet: { offline: 1, updateFailed: 1 },
        settings: { failedDeliveries: 1, byConnection: [] },
      },
    );
    expect(marked.find((item) => item.id === "ask")!.indicator).toBeUndefined();
  });

  it("points Backlog at /backlog, after Runs, lit for /backlog alone, with a page for it and its items", () => {
    const ids = navItems.map((item) => item.id);
    expect(ids.indexOf("backlog")).toBe(ids.indexOf("runs") + 1);
    expect(navItems.find((item) => item.id === "backlog")).toMatchObject({
      href: "/backlog",
      activeFor: ["/backlog"],
      placement: "main",
      phone: "tab",
    });
    expect(pages.get("/backlog")).toBeDefined();
    expect(pageFor("/backlog/linear-1")).toBe(pages.get("/backlog/[id]"));
  });

  it("gives every entry its own icon", () => {
    expect(new Set(navItems.map((item) => item.icon)).size).toBe(navItems.length);
  });

  it.each([
    ["/", "inbox"],
    ["/runs", "runs"],
    ["/runs/abc", "runs"],
    ["/backlog", "backlog"],
    ["/backlog/linear-1", "backlog"],
    ["/repos", "repos"],
    ["/repos/abc", "repos"],
    ["/fleet", "fleet"],
    ["/fleet/abc", "fleet"],
    ["/settings", "settings"],
    ["/settings/general", "settings"],
    ["/settings/advanced/routing", "settings"],
    ["/settings/connections/gitlab/abc", "settings"],
    ["/settings/organization", "settings"],
    ["/settings/routing", "settings"],
    ["/analytics", "analytics"],
    ["/ask", "ask"],
    ["/ask/new", "ask"],
    ["/ask/abc", "ask"],
  ])("makes %s active for %s alone", (pathname, id) => {
    expect(navItems.filter((item) => isNavActive(pathname, item)).map((item) => item.id)).toEqual([
      id,
    ]);
  });

  it.each(["/analyticsx", "/runsx", "/reposx", "/backlogx", "/fleetx", "/askx", "/repositories"])(
    "makes no entry active on %s",
    (pathname) => {
      expect(navItems.filter((item) => isNavActive(pathname, item))).toEqual([]);
    },
  );

  it("points Analytics at /analytics with the chart icon, before Settings in the bottom group and the phone drawer", () => {
    expect(navItems.find((item) => item.id === "analytics")).toEqual({
      id: "analytics",
      label: "Analytics",
      href: "/analytics",
      icon: IconChartBar,
      placement: "bottom",
      phone: "drawer",
      activeFor: ["/analytics"],
    });
    const bottom = navItems.filter((item) => item.placement === "bottom").map((item) => item.id);
    expect(bottom).toEqual(["ask", "analytics", "settings"]);
    expect(navItems.filter((item) => item.phone === "drawer").map((item) => item.label)).toEqual([
      "Repos",
      "Fleet",
      "Analytics",
      "Settings",
    ]);
    // Only Analytics lights up on it: Runs is lit for /runs alone.
    expect(navItems.filter((item) => isNavActive("/analytics", item)).map((i) => i.id)).toEqual([
      "analytics",
    ]);
  });

  it("points Runs at /runs, lit for /runs alone, as a phone tab", () => {
    expect(navItems.find((item) => item.id === "runs")).toMatchObject({
      href: "/runs",
      activeFor: ["/runs"],
      phone: "tab",
    });
  });

  it("points Repos at /repos, lit for /repos alone, in the phone drawer", () => {
    expect(navItems.find((item) => item.id === "repos")).toMatchObject({
      href: "/repos",
      activeFor: ["/repos"],
      phone: "drawer",
    });
  });

  it("points Fleet at /fleet, lit for /fleet, in the phone drawer", () => {
    expect(navItems.find((item) => item.id === "fleet")).toMatchObject({
      href: "/fleet",
      activeFor: ["/fleet"],
      phone: "drawer",
    });
    expect(pageFor("/fleet/abc")).toBe(pages.get("/fleet/[id]"));
    expect(pages.get("/agents")).toBeUndefined();
    expect(pages.get("/agents/[id]")).toBeUndefined();
  });

  it("makes every page reachable from an entry", () => {
    const orphaned = [...pages.keys()].filter(
      (route) =>
        !UNLISTED_PAGES.some((prefix) => route === prefix || route.startsWith(`${prefix}/`)) &&
        !navItems.some((item) => isNavActive(route, item)),
    );
    expect(orphaned).toEqual([]);
  });

  it("only links pages every member may open", () => {
    for (const item of navItems) {
      expect(item).not.toHaveProperty("adminOnly");
      if (PAGES_TO_COME.includes(item.href)) continue;
      // An admin-only page sends members to access-denied; the entry's page and the views
      // beside it must not.
      const dir = path.dirname(pageFor(item.href)!);
      const sources = readdirSync(dir)
        .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
        .map((name) => readFileSync(path.join(dir, name), "utf8"));
      for (const source of sources) {
        expect(source, item.href).not.toMatch(/ACCESS_DENIED_PATH|role !== "admin"/);
      }
    }
  });
});

describe("withNavIndicators", () => {
  const indicator = (items: ReturnType<typeof withNavIndicators>, id: string) =>
    items.find((item) => item.id === id)?.indicator;

  it("counts what needs the user on Inbox and dots Runs while runs run", () => {
    const items = withNavIndicators(navItems, { needsYou: 3, problems: 1, running: 2 });
    expect(indicator(items, "inbox")).toEqual({ kind: "count", value: 3, label: "3 need you" });
    expect(indicator(items, "runs")).toEqual({ kind: "dot", tone: "run", label: "2 running" });
    expect(indicator(items, "repos")).toBeUndefined();
  });

  it("shows neither at 0 or before the counts load", () => {
    const zero = withNavIndicators(navItems, { needsYou: 0, problems: 4, running: 0 });
    expect(zero.every((item) => item.indicator === undefined)).toBe(true);
    expect(withNavIndicators(navItems, undefined)).toBe(navItems);
    expect(withNavIndicators(navItems, undefined, undefined)).toBe(navItems);
  });

  it("gives Backlog a neutral count of its items from the Backlog counts, never at 0", () => {
    const items = withNavIndicators(navItems, undefined, {
      readyToStart: 2,
      needsRefining: 1,
      total: 3,
    });
    expect(indicator(items, "backlog")).toEqual({
      kind: "count",
      tone: "neutral",
      value: 3,
      label: "3 items",
    });
    expect(indicator(items, "inbox")).toBeUndefined();
    const one = withNavIndicators(navItems, undefined, {
      readyToStart: 0,
      needsRefining: 1,
      total: 1,
    });
    expect(indicator(one, "backlog")).toMatchObject({ value: 1, label: "1 item" });
    const zero = withNavIndicators(
      navItems,
      { needsYou: 0, problems: 0, running: 0 },
      { readyToStart: 0, needsRefining: 0, total: 0 },
    );
    expect(indicator(zero, "backlog")).toBeUndefined();
  });

  const indicators = (
    fleet: { offline: number; updateFailed: number },
    byConnection: { id: string; failed: number }[] = [],
  ) => ({
    fleet,
    settings: { failedDeliveries: byConnection.reduce((n, c) => n + c.failed, 0), byConnection },
  });

  it("dots Fleet while agents are offline or failed their update, and Settings while deliveries failed", () => {
    const items = withNavIndicators(
      navItems,
      undefined,
      undefined,
      indicators({ offline: 2, updateFailed: 1 }, [
        { id: "a", failed: 2 },
        { id: "b", failed: 1 },
      ]),
    );
    expect(indicator(items, "fleet")).toEqual({
      kind: "dot",
      tone: "fail",
      label: "3 agents need attention",
    });
    expect(indicator(items, "settings")).toEqual({
      kind: "dot",
      tone: "fail",
      label: "3 failed deliveries",
    });
    expect(indicator(items, "inbox")).toBeUndefined();
    const one = withNavIndicators(
      navItems,
      undefined,
      undefined,
      indicators({ offline: 0, updateFailed: 1 }, [{ id: "a", failed: 1 }]),
    );
    expect(indicator(one, "fleet")!.label).toBe("1 agent needs attention");
    expect(indicator(one, "settings")!.label).toBe("1 failed delivery");
  });

  it("shows no Fleet or Settings dot at 0, and keeps the Inbox counts beside them", () => {
    const items = withNavIndicators(
      navItems,
      { needsYou: 1, problems: 0, running: 0 },
      undefined,
      indicators({ offline: 0, updateFailed: 0 }),
    );
    expect(indicator(items, "fleet")).toBeUndefined();
    expect(indicator(items, "settings")).toBeUndefined();
    expect(indicator(items, "inbox")).toEqual({ kind: "count", value: 1, label: "1 need you" });
  });
});
