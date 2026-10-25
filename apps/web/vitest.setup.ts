// Testing Library's `findBy*` and `waitFor` give up after 1s by default, which a view's
// first render can exceed when every package's suite runs at once under `pnpm test`.
import { configure } from "@testing-library/dom";
import { beforeEach } from "vitest";

configure({ asyncUtilTimeout: 10_000 });

// Same for Redis: the client fails a command after 2s, which a loaded test Redis can exceed.
process.env.REDIS_COMMAND_TIMEOUT_MS ??= "10000";

// Importing `@iamthemcmaster/ui` injects the CSS of its bundled sonner toaster and vaul
// drawer into <head>: some 140 attribute-heavy rules that jsdom matches against the element
// on every `getComputedStyle`. Testing Library calls it for each element when it computes
// accessible names (`*ByRole`) and user-event for each pointer event, so those rules cost
// most of a jsdom test's time and push user-event-heavy tests past `testTimeout` under load.
// No test depends on them (toasts come from `@omniralph/ui`), so drop them before each test.
const INJECTED_LIBRARY_CSS = ["[data-sonner-toaster]", "[data-vaul-drawer]"];

beforeEach(() => {
  if (typeof document === "undefined") return;
  for (const style of document.head.querySelectorAll("style")) {
    const css = style.textContent ?? "";
    if (INJECTED_LIBRARY_CSS.some((selector) => css.startsWith(selector))) style.remove();
  }
});
