// Shared setup for the pickers' Testing Library tests (run with `@vitest-environment jsdom`):
// the browser APIs Radix Popover and cmdk use that jsdom lacks, and unmounting between tests.
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver ??= NoopResizeObserver as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.releasePointerCapture ??= () => {};

afterEach(cleanup);
