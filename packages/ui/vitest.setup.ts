// jsdom lacks a few browser APIs the Radix primitives (popper, menus, dialogs) call.
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

const elementProto = window.HTMLElement.prototype;
elementProto.hasPointerCapture ??= () => false;
elementProto.releasePointerCapture ??= () => {};
elementProto.scrollIntoView ??= () => {};

afterEach(() => {
  cleanup();
});
