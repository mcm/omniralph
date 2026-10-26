// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ListPagination } from "./list-pagination";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

afterEach(() => {
  cleanup();
  push.mockClear();
});

const hrefFor = (page: number) => `/repositories?page=${page}`;

describe("ListPagination", () => {
  it("navigates to the chosen page in place", async () => {
    render(<ListPagination page={1} pageCount={3} hrefFor={hrefFor} />);
    expect(screen.getByRole("link", { name: "1" }).getAttribute("aria-current")).toBe("page");
    await userEvent.click(screen.getByRole("link", { name: "3" }));
    expect(push).toHaveBeenCalledWith("/repositories?page=3");
    await userEvent.click(screen.getByRole("link", { name: /next/i }));
    expect(push).toHaveBeenLastCalledWith("/repositories?page=2");
  });

  it("switches pages without navigating for client-side lists", async () => {
    const onSelect = vi.fn();
    render(<ListPagination page={2} pageCount={3} hrefFor={hrefFor} onSelect={onSelect} />);
    await userEvent.click(screen.getByRole("link", { name: /previous/i }));
    expect(onSelect).toHaveBeenCalledWith(1);
    expect(push).not.toHaveBeenCalled();
  });

  it("renders nothing for a single page", () => {
    const { container } = render(<ListPagination page={1} pageCount={1} hrefFor={hrefFor} />);
    expect(container.innerHTML).toBe("");
  });
});
