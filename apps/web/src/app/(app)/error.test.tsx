// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import AppError from "./error";

vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));

afterEach(cleanup);

describe("AppError", () => {
  it("shows the error in place with a retry that renders the page again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const retry = vi.fn();
    render(
      <AppError error={Object.assign(new Error("boom"), { digest: "123abc" })} retry={retry} />,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Something went wrong" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Couldn't show this page" })).toBeTruthy();
    // The message isn't for users (production hides server messages anyway); the digest is.
    expect(document.body.textContent).not.toContain("boom");
    expect(document.body.textContent).toContain("123abc");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
