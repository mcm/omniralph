// Runs inside the mcr.microsoft.com/playwright container (see verify.ts), never on the
// host: `node capture.mjs config.json`. Screenshots every route of the config in every
// viewport and theme into `config.outDir`, with an HTML snapshot (styles inlined, for
// `impeccable detect`) and `results.json`.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";

const config = JSON.parse(await readFile(process.argv[2], "utf8"));
const { baseUrl, signInPath, routes, themes, viewports, outDir } = config;
const NAVIGATION_TIMEOUT_MS = 180_000; // `next dev` compiles each route on its first visit.

// Hides the `next dev` indicator and overlay; errors are recorded instead.
const HIDE_DEV_UI = "nextjs-portal { display: none !important; }";

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
const results = [];
try {
  const signedIn = await signIn();
  for (const [viewportName, viewport] of Object.entries(viewports)) {
    for (const theme of themes) {
      for (const auth of ["signed-out", "signed-in"]) {
        const group = routes.filter((route) => route.auth === auth);
        if (group.length === 0) continue;
        const context = await browser.newContext({
          baseURL: baseUrl,
          viewport,
          colorScheme: theme,
          ...(viewportName === "phone"
            ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true }
            : {}),
          ...(auth === "signed-in" ? { storageState: signedIn } : {}),
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

/** Signs in with the dev sign-in once; returns the session's storage state. */
async function signIn() {
  const context = await browser.newContext({ baseURL: baseUrl });
  const response = await context.request.get(signInPath, {
    maxRedirects: 0,
    timeout: NAVIGATION_TIMEOUT_MS,
  });
  if (response.status() !== 307 && response.status() !== 302) {
    throw new Error(`dev sign-in failed: HTTP ${response.status()} ${await response.text()}`);
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
    auth: route.auth,
    viewport: viewportName,
    width: viewport.width,
    theme,
    status: null,
    finalPath: null,
    scrollWidth: null,
    overflow: false,
    themeForced: false,
    consoleErrors: [],
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
    const response = await page.goto(route.path, { waitUntil: "load" });
    result.status = response?.status() ?? null;
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await page.addStyleTag({ content: HIDE_DEV_UI });
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
    result.overflow ? `overflow ${result.scrollWidth}px` : null,
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
