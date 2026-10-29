// Runs inside the mcr.microsoft.com/playwright container (see verify.ts), never on the
// host: `node capture.mjs config.json`. Screenshots every route of the config in every
// viewport and theme into `config.outDir`, with an HTML snapshot (styles inlined, for
// `impeccable detect`) and `results.json`. Routes are the panel's, or the agent page's
// (`surface: "agent"`, served by its fixture mode at `config.agent.baseUrl`).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";

const config = JSON.parse(await readFile(process.argv[2], "utf8"));
const { baseUrl, signInPaths, organizationCookie, routes, themes, viewports, outDir, agent } =
  config;
const NAVIGATION_TIMEOUT_MS = 180_000; // `next dev` compiles each route on its first visit.
// Pages load their data from `/api/ui` after rendering (skeletons are `aria-busy`), and keep
// polling it, so the network never goes idle: wait for the skeletons to go instead.
const LOADED_TIMEOUT_MS = 60_000;

// Hides the `next dev` indicator and overlay; errors are recorded instead.
const HIDE_DEV_UI = "nextjs-portal { display: none !important; }";

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
  };
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") result.consoleErrors.push(message.text().slice(0, 500));
  });
  page.on("pageerror", (error) => result.consoleErrors.push(String(error).slice(0, 500)));
  try {
    // Another organization than the user's active one: the organization cookie, for this page.
    if (route.surface !== "agent") await context.clearCookies({ name: organizationCookie });
    if (route.organization) {
      await context.addCookies([
        { name: organizationCookie, value: route.organization, url: baseUrl },
      ]);
    }
    const response = await page.goto(route.path, { waitUntil: "load" });
    result.status = response?.status() ?? null;
    const loaded = await page
      .waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, {
        timeout: LOADED_TIMEOUT_MS,
      })
      .then(
        () => true,
        () => false,
      );
    if (!loaded) result.notRendered = `still loading after ${LOADED_TIMEOUT_MS / 1000}s`;
    // The agent page renders nothing until its data loads: wait for what each route names.
    const waitFor = typeof route.waitFor === "string" ? [route.waitFor] : (route.waitFor ?? []);
    const waited = await Promise.all(
      waitFor.map((selector) =>
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
    // In-place errors: a failed load (the panel's QueryBoundary, the agent page's "Can't load"
    // empty states) or a render error ((app)/error.tsx).
    result.loadErrors = await page.$$eval(".query-error, .or-empty__title", (alerts) =>
      alerts
        .filter((alert) => alert.matches(".query-error") || /^Can't load/.test(alert.textContent))
        .map((alert) => alert.textContent?.replace(/\s+/g, " ").trim().slice(0, 300) ?? ""),
    );
    if (result.loadErrors.some((text) => text.startsWith("Couldn't show this page"))) {
      result.notRendered = "the page's error boundary (render error)";
    }
    const missing = waited.filter(Boolean);
    if (missing.length > 0) result.notRendered ??= `never showed ${missing.join(", ")}`;
    // The agent page has no dev overlay, and its CSP refuses inline styles.
    if (route.surface !== "agent") await page.addStyleTag({ content: HIDE_DEV_UI });
    for (const step of route.steps ?? []) {
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
      if (step.action === "fill") await target.fill(step.value);
      else await target.click();
    }
    // The signed-in user's saved theme wins over the emulated OS preference.
    result.themeForced = await page.evaluate((wanted) => {
      const root = document.documentElement;
      if (root.getAttribute("data-theme") === wanted) return false;
      root.setAttribute("data-theme", wanted);
      return true;
    }, theme);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
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
    await page.screenshot({
      path: join(outDir, result.screenshot),
      fullPage: !route.viewportOnly,
      animations: "disabled",
    });
    result.html = `${base}.html`;
    await writeFile(join(outDir, result.html), await snapshotHtml(page));
  } catch (error) {
    result.error = String(error?.message ?? error).slice(0, 2000);
  } finally {
    await page.close();
  }
  const flags = [
    result.error ? "ERROR" : null,
    result.notRendered ? `not rendered: ${result.notRendered}` : null,
    result.loadErrors.length > 0 ? `${result.loadErrors.length} load error(s)` : null,
    result.overflow ? `overflow ${result.scrollWidth}px` : null,
    result.kbdCount > 0 ? `${result.kbdCount} kbd` : null,
    result.retiredWording.length > 0 ? "retired wording" : null,
  ].filter(Boolean);
  console.log(`${base} ${result.status ?? "-"}${flags.length ? ` (${flags.join(", ")})` : ""}`);
  return result;
}

/**
 * The page's DOM as a standalone HTML file: every stylesheet inlined (static
 * analysis can't fetch `/_next/…` URLs), scripts and the dev overlay removed.
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
      .querySelectorAll("script, style, link[rel='stylesheet'], link[as='script'], nextjs-portal")
      .forEach((element) => element.remove());
    const style = document.createElement("style");
    style.textContent = css;
    (root.querySelector("head") ?? root).appendChild(style);
    return `<!doctype html>\n${root.outerHTML}`;
  });
}
