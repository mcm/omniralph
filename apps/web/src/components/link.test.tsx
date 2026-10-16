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
    const { rerender } = render(<Link href="/jobs">Jobs</Link>);
    const link = screen.getByRole("link", { name: "Jobs" });
    expect(link.getAttribute("href")).toBe("/jobs");
    expect(link.querySelector(".link-status[data-pending]")).toBeNull();

    status.pending = true;
    rerender(<Link href="/jobs">Jobs</Link>);
    expect(link.querySelector(".link-status[data-pending]")).not.toBeNull();
    // The marker isn't read out: the link's name stays its label.
    expect(screen.getByRole("link", { name: "Jobs" })).toBe(link);
  });
});
