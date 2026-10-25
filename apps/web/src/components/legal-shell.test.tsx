// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LegalShell } from "./legal-shell";

vi.mock("next/link", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useLinkStatus: () => ({ pending: false }),
}));

afterEach(cleanup);

describe("LegalShell", () => {
  it("puts the document in a prose column under the home-linked brand lockup", () => {
    render(
      <LegalShell>
        <article>
          <h1>Terms of service</h1>
        </article>
      </LegalShell>,
    );
    const main = screen.getByRole("main");
    expect(main.classList).toContain("or-root");
    expect(within(main).getByRole("link", { name: "Omniralph home" }).getAttribute("href")).toBe(
      "/",
    );
    const heading = screen.getByRole("heading", { level: 1, name: "Terms of service" });
    expect(heading.closest(".legal-document")).not.toBeNull();
    const legal = screen.getByRole("navigation", { name: "Legal" });
    expect(within(legal).getByRole("link", { name: "Privacy policy" }).getAttribute("href")).toBe(
      "/privacy",
    );
  });
});
