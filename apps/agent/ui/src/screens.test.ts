import { describe, expect, it } from "vitest";
import { AGENT_SCREEN_ROUTES } from "../../scripts/ui-fixture/routes.js";
import { AGENT_SECTIONS, INDEX_PATH } from "./nav.js";

// `verify:screens` captures the page through its fixture mode's routes: every screen of it.
describe("the fixture mode's screenshot routes", () => {
  it("capture every section, the section list, an attempt and an install's output", () => {
    const paths = AGENT_SCREEN_ROUTES.map((route) => route.path);
    for (const section of Object.values(AGENT_SECTIONS)) expect(paths).toContain(section.href);
    expect(paths).toContain(INDEX_PATH);
    expect(paths.some((path) => path.startsWith("/attempts/"))).toBe(true);
    expect(paths.some((path) => path.startsWith("/packages/history/"))).toBe(true);
  });

  it("have unique, file-name-safe names apart from the panel's", () => {
    const names = AGENT_SCREEN_ROUTES.map((route) => route.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^agent-[a-z0-9-]+$/);
  });
});
