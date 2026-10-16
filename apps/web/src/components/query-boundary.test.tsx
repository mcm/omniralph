// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useQuery } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { QueryBoundary } from "./query-boundary";
import { createTestQueryClient, queryWrapper } from "./query-test-utils";

afterEach(cleanup);

function Harnesses({ queryFn }: { queryFn: () => Promise<string[]> }) {
  const query = useQuery({ queryKey: ["org", "harnesses", "list", {}], queryFn });
  return (
    <QueryBoundary query={query} what="harnesses" skeleton={<div data-testid="skeleton" />}>
      {(names) => (
        <ul>
          {names.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      )}
    </QueryBoundary>
  );
}

function setup(queryFn: () => Promise<string[]>) {
  return render(<Harnesses queryFn={queryFn} />, {
    wrapper: queryWrapper(createTestQueryClient()),
  });
}

describe("QueryBoundary", () => {
  it("shows the skeleton while pending, then the data", async () => {
    let resolve: (names: string[]) => void = () => {};
    setup(() => new Promise((r) => (resolve = r)));
    expect(screen.getByTestId("skeleton")).toBeTruthy();
    expect(screen.getByLabelText("Loading harnesses").getAttribute("aria-busy")).toBe("true");
    resolve(["build-01"]);
    expect(await screen.findByText("build-01")).toBeTruthy();
    expect(screen.queryByTestId("skeleton")).toBeNull();
  });

  it("shows the error in place with a Retry that refetches", async () => {
    const queryFn = vi
      .fn<() => Promise<string[]>>()
      .mockRejectedValueOnce(new ApiError("This action requires the admin role.", 403))
      .mockResolvedValueOnce(["build-02"]);
    setup(queryFn);
    expect(await screen.findByText("Couldn't load harnesses")).toBeTruthy();
    expect(screen.getByText("This action requires the admin role.")).toBeTruthy();
    expect(screen.queryByTestId("skeleton")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("build-02")).toBeTruthy();
    expect(queryFn).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Couldn't load harnesses")).toBeNull();
  });

  it("keeps showing the data when a later refetch fails", async () => {
    const client = createTestQueryClient();
    const queryFn = vi
      .fn<() => Promise<string[]>>()
      .mockResolvedValueOnce(["build-01"])
      .mockRejectedValue(new ApiError("Couldn't reach the server.", 0));
    render(<Harnesses queryFn={queryFn} />, { wrapper: queryWrapper(client) });
    expect(await screen.findByText("build-01")).toBeTruthy();
    await client.refetchQueries();
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
    expect(screen.getByText("build-01")).toBeTruthy();
    expect(screen.queryByText("Couldn't load harnesses")).toBeNull();
  });
});
