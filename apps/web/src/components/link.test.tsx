// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Link } from "./link";

const status = vi.hoisted(() => ({ pending: false }));
vi.mock("next/link", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useLinkStatus: () => status,
}));

afterEach(cleanup);

describe("Link", () => {
  it("marks the link pending while its page loads", () => {
    status.pending = false;
    const { rerender } = render(<Link href="/runs">Runs</Link>);
    const link = screen.getByRole("link", { name: "Runs" });
    expect(link.getAttribute("href")).toBe("/runs");
    expect(link.querySelector(".link-status[data-pending]")).toBeNull();

    status.pending = true;
    rerender(<Link href="/runs">Runs</Link>);
    expect(link.querySelector(".link-status[data-pending]")).not.toBeNull();
    // The marker isn't read out: the link's name stays its label.
    expect(screen.getByRole("link", { name: "Runs" })).toBe(link);
  });
});
