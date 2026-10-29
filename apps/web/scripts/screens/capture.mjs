// Runs inside the mcr.microsoft.com/playwright container (see verify.ts), never on the
// host: `node capture.mjs config.json`. Screenshots every route of the config in every
// viewport and theme into `config.outDir`, with an HTML snapshot (styles inlined, for
// `impeccable detect`) and `results.json`. Routes are the panel's, or the agent page's
// (`surface: "agent"`, served by its fixture mode at `config.agent.baseUrl`). After each
// screenshot it runs the Decided checks (`decided-page.mjs`, with each route's `decided`
// options) and the accessibility checks (`a11y-page.mjs`): axe-core, the ARIA snapshot and
// landmarks, the Escape check on overlays the steps opened, and the keyboard walk.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { chromium } from "playwright-core";
import {
  analyzeKeyboardWalk,
  AXE_TAGS,
  keyboardInPage,
  keyboardStops,
  landmarksInPage,
  overlaysInPage,
  walkKeyboard,
} from "./a11y-page.mjs";
import { decidedInPage, expandedInPage } from "./decided-page.mjs";

const config = JSON.parse(await readFile(process.argv[2], "utf8"));
const {
  baseUrl,
  signInPaths,
  organizationCookie,
  organizationScopeCookie,
  routes,
  themes,
  viewports,
  outDir,
  agent,
} = config;
const NAVIGATION_TIMEOUT_MS = 180_000; // `next dev` compiles each route on its first visit.
// Pages load their data from `/api/ui` after rendering (skeletons are `aria-busy`), and keep
// polling it, so the network never goes idle: wait for the skeletons to go instead.
const LOADED_TIMEOUT_MS = 60_000;

// Hides the `next dev` indicator and overlay (errors are recorded instead) and the React Query
// devtools, so neither is captured or checked.
const HIDE_DEV_UI = "nextjs-portal, .tsqd-parent-container { display: none !important; }";

// axe-core's browser build, evaluated in each page (the agent page's CSP refuses script tags).
const AXE_SOURCE = await readFile(
  createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  "utf8",
);
/** The Decided checks' fields of a result (decided-page.mjs, and `phoneExpanded`). */
const DECIDED_FIELDS = [
  "hintText",
  "liveIndicator",
  "detailToolbar",
  "bareMetadata",
  "rowSummary",
  "phoneExpanded",
  "orgFirst",
];

// How long an overlay may take to close after Escape (exit animations).
const CLOSE_TIMEOUT_MS = 2_000;

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
const results = [];
try {
  // Who each route is captured as: nobody (signed out), the admin, or the member (`as`), on
  // the panel; the agent page's link signs in to the agent page.
  const userOf = (route) =>
    route.surface === "agent"
      ? "agent"
      : route.auth === "signed-out"
        ? null
        : (route.as ?? "admin");
  const baseUrlOf = (user) => (user === "agent" ? agent.baseUrl : baseUrl);
  const sessions = {};
  for (const user of new Set(routes.map(userOf))) {
    if (user) {
      sessions[user] = await signIn(
        baseUrlOf(user),
        user === "agent" ? agent.signInPath : signInPaths[user],
      );
    }
  }
  for (const [viewportName, viewport] of Object.entries(viewports)) {
    for (const theme of themes) {
      for (const user of [null, "admin", "member", "agent"]) {
        const group = routes.filter(
          (route) =>
            userOf(route) === user && (!route.viewports || route.viewports.includes(viewportName)),
        );
        if (group.length === 0) continue;
        const context = await browser.newContext({
          baseURL: baseUrlOf(user),
          viewport,
          colorScheme: theme,
          ...(viewportName === "phone"
            ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true }
            : {}),
          ...(user ? { storageState: sessions[user] } : {}),
        });
        context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
        for (const route of group) {
          results.push(await capture(context, route, viewportName, viewport, theme));
        }
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  await writeFile(join(outDir, "results.json"), JSON.stringify(results, null, 2));
}

/**
 * Signs in once per user, with the panel's dev sign-in or the agent page's link (which trades
 * its token for a cookie with a 303); returns the session's storage state.
 */
async function signIn(base, signInPath) {
  const context = await browser.newContext({ baseURL: base });
  const response = await context.request.get(signInPath, {
    maxRedirects: 0,
    timeout: NAVIGATION_TIMEOUT_MS,
  });
  if (![302, 303, 307].includes(response.status())) {
    throw new Error(`sign-in failed: HTTP ${response.status()} ${await response.text()}`);
  }
  const state = await context.storageState();
  await context.close();
  return state;
}

async function capture(context, route, viewportName, viewport, theme) {
  const base = `${route.name}.${viewportName}.${theme}`;
  const result = {
    route: route.name,
    path: route.path,
    surface: route.surface ?? "panel",
    auth: route.auth,
    as: route.surface === "agent" || route.auth === "signed-out" ? null : (route.as ?? "admin"),
    viewport: viewportName,
    width: viewport.width,
    theme,
    status: null,
    finalPath: null,
    scrollWidth: null,
    overflow: false,
    kbdCount: 0,
    retiredWording: [],
    themeForced: false,
    consoleErrors: [],
    notRendered: null,
    loadErrors: [],
    error: null,
    screenshot: null,
    html: null,
    axe: [],
    keyboard: [],
    keyboardStops: [],
    escape: null,
    landmarks: [],
    checkErrors: [],
    axeFile: null,
    ariaFile: null,
    // The Decided checks (decided-page.mjs).
    hintText: [],
    liveIndicator: [],
    detailToolbar: [],
    bareMetadata: [],
    rowSummary: [],
    phoneExpanded: [],
    orgFirst: [],
  };
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // "Failed to load resource" doesn't say which: its location is the resource.
    const { url } = message.location();
    const text = message.text().startsWith("Failed to load resource") && url
      ? `${message.text()} (${new URL(url).pathname})`
      : message.text();
    result.consoleErrors.push(text.slice(0, 500));
  });
  page.on("pageerror", (error) => result.consoleErrors.push(String(error).slice(0, 500)));
  try {
    const { overlays } = await openRoute(context, page, route, theme, result, viewportName);
    await page.evaluate(() => document.fonts.ready);
    const url = new URL(page.url());
    result.finalPath = url.pathname + url.search;
    result.scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    result.overflow = result.scrollWidth > viewport.width;
    // Rule 7: no keyboard-shortcut indicators outside the Help page. The visible `kbd`s.
    result.kbdCount = await page.$$eval(
      "kbd",
      (elements) =>
        elements.filter(
          (element) =>
            element.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
            element.getClientRects().length > 0,
        ).length,
    );
    // The product says "Om" and "agent", never "Ralph" or "harness": the visible text around
    // each. Identifiers shown as data keep the old word: job types (`ralph.story`) and the
    // `ralph-run` sink of a task definition.
    result.retiredWording = await page.evaluate(() => {
      const text = document.body.innerText.replace(/\bralph(\.[a-z-]+|-run)\b/gi, (word) =>
        "_".repeat(word.length),
      );
      return [...text.matchAll(/\b(ralph|harness)\b/gi)].map((match) =>
        text
          .slice(Math.max(0, match.index - 40), match.index + 45)
          .replace(/\s+/g, " ")
          .trim(),
      );
    });

    result.screenshot = `${base}.png`;
    // A full-page screenshot resizes the viewport and leaves the page scrolled elsewhere (a
    // focused heading ends up under the sticky top bar): put it back, so the checks below see
    // the page as it was captured.
    const scrolled = await page.evaluate(() => [scrollX, scrollY]);
    await page.screenshot({
      path: join(outDir, result.screenshot),
      fullPage: !route.viewportOnly,
      animations: "disabled",
    });
    await page.evaluate(([x, y]) => scrollTo({ left: x, top: y, behavior: "instant" }), scrolled);
    result.html = `${base}.html`;
    await writeFile(join(outDir, result.html), await snapshotHtml(page));

    if (route.decided) {
      await check(result, "decided", async () => {
        Object.assign(result, await page.evaluate(decidedInPage, route.decided));
      });
    }
    await checkAccessibility(page, base, viewportName, result);
    if (overlays.length > 0) {
      await check(result, "escape", () => checkEscape(page, overlays, result));
      // Escape closed the overlay: open it again, so the walk covers what it holds.
      await openRoute(context, page, route, theme, { loadErrors: [] }, viewportName);
    }
    await check(result, "keyboard", () => checkKeyboard(page, result));
  } catch (error) {
    result.error = String(error?.message ?? error).slice(0, 2000);
  } finally {
    await page.close();
  }
  const findings = (name, list) => (list?.length ? `${list.length} ${name}` : null);
  const flags = [
    result.error ? "ERROR" : null,
    result.notRendered ? `not rendered: ${result.notRendered}` : null,
    result.loadErrors.length > 0 ? `${result.loadErrors.length} load error(s)` : null,
    result.overflow ? `overflow ${result.scrollWidth}px` : null,
    result.kbdCount > 0 ? `${result.kbdCount} kbd` : null,
    result.retiredWording.length > 0 ? "retired wording" : null,
    findings("axe", result.axe),
    findings("keyboard", result.keyboard),
    findings("escape", result.escape),
    findings("landmarks", result.landmarks),
    ...DECIDED_FIELDS.map((field) => findings(field, result[field])),
    result.checkErrors.length > 0 ? `${result.checkErrors.length} check error(s)` : null,
  ].filter(Boolean);
  console.log(`${base} ${result.status ?? "-"}${flags.length ? ` (${flags.join(", ")})` : ""}`);
  return result;
}

/**
 * Opens `route` in `page`: its organization (and "All organizations" with `org: "all"`), the
 * page, its content (skeletons gone, `waitFor`), its steps and the theme; a route with steps
 * waits for its first step's target before them and for `waitFor` after them. Records the
 * status and what didn't render in `record`, and (a detail at phone width) the Details
 * expanded on load, before the steps. Returns the overlays the steps opened (`overlaysInPage`); the target
 * of each click step is marked as a possible opener for the Escape check.
 */
async function openRoute(context, page, route, theme, record, viewportName) {
  // Another organization than the user's active one: the organization cookie, for this page.
  if (route.surface !== "agent") {
    await context.clearCookies({ name: organizationCookie });
    await context.clearCookies({ name: organizationScopeCookie });
  }
  if (route.organization) {
    await context.addCookies([
      { name: organizationCookie, value: route.organization, url: baseUrl },
    ]);
  }
  if (route.org === "all") {
    await context.addCookies([{ name: organizationScopeCookie, value: "all", url: baseUrl }]);
  }
  const response = await page.goto(route.path, { waitUntil: "load" });
  record.status = response?.status() ?? null;
  const loaded = await page
    .waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, {
      timeout: LOADED_TIMEOUT_MS,
    })
    .then(
      () => true,
      () => false,
    );
  if (!loaded) record.notRendered = `still loading after ${LOADED_TIMEOUT_MS / 1000}s`;
  // What the route names (`waitFor`) shows once its data has loaded (the agent page renders
  // nothing until then). With steps, it may only show after them (the Ask panel's chats list,
  // opened by a click): wait for the first step's target first, and for it after the steps.
  const waitFor = typeof route.waitFor === "string" ? [route.waitFor] : (route.waitFor ?? []);
  const steps = route.steps ?? [];
  const missing = await waitForAll(page, steps.length > 0 ? [steps[0].selector] : waitFor);
  // In-place errors: a failed load (the panel's QueryBoundary, the agent page's "Can't load"
  // empty states) or a render error ((app)/error.tsx).
  record.loadErrors = await page.$$eval(".query-error, .or-empty__title", (alerts) =>
    alerts
      .filter((alert) => alert.matches(".query-error") || /^Can't load/.test(alert.textContent))
      .map((alert) => alert.textContent?.replace(/\s+/g, " ").trim().slice(0, 300) ?? ""),
  );
  if (record.loadErrors.some((text) => text.startsWith("Couldn't show this page"))) {
    record.notRendered = "the page's error boundary (render error)";
  }
  if (missing.length > 0) record.notRendered ??= `never showed ${missing.join(", ")}`;
  // Rule 16: a detail loads with its Details collapsed on a phone (before any step opens one).
  if (viewportName === "phone" && route.detail) {
    record.phoneExpanded = await page.evaluate(expandedInPage);
  }
  // The agent page has no dev overlay, and its CSP refuses inline styles.
  if (route.surface !== "agent") await page.addStyleTag({ content: HIDE_DEV_UI });
  const before = new Set(
    (await page.evaluate(overlaysInPage, { action: "list" })).map(({ key }) => key),
  );
  let clicks = 0;
  for (const step of steps) {
    const target = page.locator(step.selector).first();
    // Typing before React hydrates the element is lost or doubled: wait for its props.
    await target.waitFor();
    await page
      .waitForFunction(
        (element) => Object.keys(element).some((key) => key.startsWith("__reactProps")),
        await target.elementHandle(),
        { timeout: 15_000 },
      )
      .catch(() => {});
    if (step.action === "fill") {
      await target.fill(step.value);
    } else {
      await target.evaluate(
        (element, index) => element.setAttribute("data-a11y-opener", index),
        String(clicks++),
      );
      await target.click();
    }
  }
  if (steps.length > 0) {
    const shown = await waitForAll(page, waitFor);
    if (shown.length > 0) record.notRendered ??= `never showed ${shown.join(", ")}`;
  }
  // The signed-in user's saved theme wins over the emulated OS preference.
  record.themeForced = await page.evaluate((wanted) => {
    const root = document.documentElement;
    if (root.getAttribute("data-theme") === wanted) return false;
    root.setAttribute("data-theme", wanted);
    return true;
  }, theme);
  await page.waitForTimeout(300);
  const after = await page.evaluate(overlaysInPage, { action: "list" });
  return { overlays: after.filter(({ key }) => !before.has(key)) };
}

/** Waits for each of `selectors` (up to 30s); returns those that never showed. */
async function waitForAll(page, selectors) {
  const waited = await Promise.all(
    selectors.map((selector) =>
      page
        .locator(selector)
        .first()
        .waitFor({ timeout: 30_000 })
        .then(
          () => null,
          () => selector,
        ),
    ),
  );
  return waited.filter(Boolean);
}

/** Runs one check; a check that throws is recorded in `checkErrors`, not the capture's error. */
async function check(result, name, run) {
  try {
    await run();
  } catch (error) {
    result.checkErrors.push(`${name}: ${String(error?.message ?? error).slice(0, 500)}`);
  }
}

/** The ARIA snapshot, axe-core and the landmarks, on the page as captured. */
async function checkAccessibility(page, base, viewportName, result) {
  await check(result, "aria", async () => {
    const snapshot = await page.locator("body").ariaSnapshot();
    result.ariaFile = `${base}.aria.yml`;
    await writeFile(join(outDir, result.ariaFile), snapshot);
  });
  await check(result, "axe", async () => {
    await page.evaluate(AXE_SOURCE);
    const report = await page.evaluate(async (tags) => {
      const rules = window.axe
        .getRules(tags)
        .concat(window.axe.getRules().filter((rule) => rule.ruleId.startsWith("landmark-")))
        .filter((rule) => !rule.tags.includes("experimental") && !rule.tags.includes("deprecated"))
        .map((rule) => rule.ruleId);
      const results = await window.axe.run(document, {
        runOnly: { type: "rule", values: [...new Set(rules)] },
        resultTypes: ["violations"],
      });
      return {
        testEngine: results.testEngine,
        url: results.url,
        timestamp: results.timestamp,
        rules: [...new Set(rules)],
        violations: results.violations,
      };
    }, AXE_TAGS);
    result.axeFile = `${base}.axe.json`;
    await writeFile(join(outDir, result.axeFile), JSON.stringify(report, null, 2));
    result.axe = report.violations.flatMap((violation) =>
      violation.nodes.map((node) => ({
        rule: violation.id,
        impact: node.impact ?? violation.impact ?? null,
        target: node.target.map((part) => [part].flat().join(" >>> ")).join(" "),
        summary: (node.failureSummary || violation.help)
          .replace(/^Fix (any|all) of the following:\s*/i, "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 400),
      })),
    );
  });
  await check(result, "landmarks", async () => {
    result.landmarks = await page.evaluate(landmarksInPage, { navNames: viewportName === "rail" });
  });
}

/**
 * Escape on the overlays the route's steps opened: each must close, and the focus must go back
 * to the control that opened it.
 */
async function checkEscape(page, overlays, result) {
  await page.keyboard.press("Escape");
  const keys = overlays.map(({ key }) => key);
  const deadline = Date.now() + CLOSE_TIMEOUT_MS;
  let open = await page.evaluate(overlaysInPage, { action: "open", keys });
  while (open.length > 0 && Date.now() < deadline) {
    await page.waitForTimeout(100);
    open = await page.evaluate(overlaysInPage, { action: "open", keys });
  }
  // Focus moves back as the overlay closes, or just after.
  await page.waitForTimeout(200);
  const focus = await page.evaluate(overlaysInPage, { action: "focus" });
  result.escape = escapeFindings(overlays, open, focus);
}

/** The Escape check's findings, from the overlays opened, those still open, and the focus. */
function escapeFindings(overlays, stillOpen, focus) {
  const findings = overlays
    .filter(({ key }) => stillOpen.includes(key))
    .map(({ target }) => ({ rule: "stays-open", target, summary: "Escape doesn't close it" }));
  if (stillOpen.length < overlays.length && !focus.returned) {
    findings.push({
      rule: "focus-not-restored",
      target: overlays[0].target,
      summary: focus.opener
        ? `After Escape the focus is on ${focus.focused}, not on ${focus.opener}, which opened it`
        : `After Escape the focus is on ${focus.focused}: the control that opened it is gone`,
    });
  }
  return findings;
}

/** The keyboard walk (a11y-page.mjs) from the top of the page. */
async function checkKeyboard(page, result) {
  await page.mouse.move(0, 0);
  const required = await page.evaluate(keyboardInPage, { action: "prepare", pseudo: true });
  const walk = await walkKeyboard({
    press: () => page.keyboard.press("Tab"),
    state: () => page.evaluate(keyboardInPage, { action: "state", pseudo: true }),
  });
  await page.evaluate(keyboardInPage, { action: "cleanup" });
  result.keyboardStops = keyboardStops(walk.stops);
  result.keyboard = analyzeKeyboardWalk({ required, ...walk });
}

/**
 * The page's DOM as a standalone HTML file: every stylesheet inlined (static
 * analysis can't fetch `/_next/…` URLs), scripts and the dev UI (HIDE_DEV_UI) removed.
 */
function snapshotHtml(page) {
  return page.evaluate(() => {
    const css = [...document.styleSheets]
      .map((sheet) => {
        try {
          return [...sheet.cssRules].map((rule) => rule.cssText).join("\n");
        } catch {
          return "";
        }
      })
      .join("\n");
    const root = document.documentElement.cloneNode(true);
    root
      .querySelectorAll(
        "script, style, link[rel='stylesheet'], link[as='script'], nextjs-portal, .tsqd-parent-container",
      )
      .forEach((element) => element.remove());
    const style = document.createElement("style");
    style.textContent = css;
    (root.querySelector("head") ?? root).appendChild(style);
    return `<!doctype html>\n${root.outerHTML}`;
  });
}
