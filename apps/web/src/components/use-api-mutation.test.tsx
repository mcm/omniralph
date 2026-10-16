// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/keys";
import { createTestQueryClient, queryWrapper, TEST_ORGANIZATION_ID } from "./query-test-utils";
import { MUTATION_FAILED, useApiMutation } from "./use-api-mutation";

const ui = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock("@iamthemcmaster/ui", () => ui);
const guard = vi.hoisted(() => ({ stale: false }));
vi.mock("./organization-guard", () => ({ useIsOrganizationStale: () => () => guard.stale }));

const keys = queryKeys(TEST_ORGANIZATION_ID);

beforeEach(() => {
  ui.notify.mockReset();
  guard.stale = false;
});
afterEach(cleanup);

function setup<TData>(options: Partial<Parameters<typeof useApiMutation<TData, string>>[0]>) {
  const client = createTestQueryClient();
  const mutationFn = vi.fn<(v: string, meta: { organizationId: string }) => Promise<TData>>();
  const { result } = renderHook(
    () =>
      useApiMutation<TData, string>({
        mutationFn,
        invalidate: (k) => [k.harnesses.all],
        success: "Harness renamed",
        ...options,
      }),
    { wrapper: queryWrapper(client) },
  );
  return { client, mutationFn, result };
}

describe("useApiMutation", () => {
  it("toasts success, invalidates the keys by prefix and calls onSuccess", async () => {
    const onSuccess = vi.fn();
    const { client, mutationFn, result } = setup({ onSuccess });
    client.setQueryData(keys.harnesses.list(), ["old"]);
    client.setQueryData(keys.harnesses.detail("h1"), { name: "old" });
    const other = keys.jobs.list();
    client.setQueryData(other, ["job"]);

    mutationFn.mockResolvedValue({ ok: true } as never);
    await act(() => result.current.mutateAsync("h1"));

    expect(mutationFn).toHaveBeenCalledWith("h1", { organizationId: TEST_ORGANIZATION_ID });
    expect(ui.notify).toHaveBeenCalledWith("Harness renamed");
    expect(client.getQueryState(keys.harnesses.list())?.isInvalidated).toBe(true);
    expect(client.getQueryState(keys.harnesses.detail("h1"))?.isInvalidated).toBe(true);
    expect(client.getQueryState(other)?.isInvalidated).toBe(false);
    expect(onSuccess).toHaveBeenCalledWith({ ok: true }, "h1");
  });

  it("navigates only after the invalidated queries refetched", async () => {
    const order: string[] = [];
    const { client, mutationFn, result } = setup({ onSuccess: () => order.push("navigate") });
    // An observed (mounted) query, so invalidation refetches it.
    const unsubscribe = new QueryObserver(client, {
      queryKey: keys.harnesses.list(),
      queryFn: async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push("refetched");
        return ["new"];
      },
    }).subscribe(() => {});
    await waitFor(() => expect(order).toEqual(["refetched"]));
    order.length = 0;

    mutationFn.mockResolvedValue({ ok: true } as never);
    await act(() => result.current.mutateAsync("h1"));
    expect(order).toEqual(["refetched", "navigate"]);
    unsubscribe();
  });

  it("shows a result's warning instead of the success toast", async () => {
    const { mutationFn, result } = setup({});
    mutationFn.mockResolvedValue({ ok: true, warning: "Renamed, but offline." } as never);
    await act(() => result.current.mutateAsync("h1"));
    expect(ui.notify).toHaveBeenCalledTimes(1);
    expect(ui.notify).toHaveBeenCalledWith("Renamed, but offline.", { variant: "warning" });
  });

  it("builds the success toast from the result, or shows none", async () => {
    const first = setup<{ ok: true; name: string }>({
      success: (data, name) => `Renamed ${name} to ${data.name}`,
    });
    first.mutationFn.mockResolvedValue({ ok: true, name: "build-02" });
    await act(() => first.result.current.mutateAsync("build-01"));
    expect(ui.notify).toHaveBeenCalledWith("Renamed build-01 to build-02");

    ui.notify.mockReset();
    const second = setup({ success: null });
    second.mutationFn.mockResolvedValue({ ok: true } as never);
    await act(() => second.result.current.mutateAsync("x"));
    expect(ui.notify).not.toHaveBeenCalled();
  });

  it("toasts the server's message as danger, calls onError and still invalidates", async () => {
    const onError = vi.fn();
    const onSuccess = vi.fn();
    const { client, mutationFn, result } = setup({ onError, onSuccess });
    client.setQueryData(keys.harnesses.detail("h1"), { name: "optimistic" });
    const error = new ApiError("That name is taken.", 400, undefined, { name: "Taken" });
    mutationFn.mockRejectedValue(error);
    act(() => result.current.mutate("h1"));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(ui.notify).toHaveBeenCalledWith("That name is taken.", { variant: "danger" });
    expect(onError).toHaveBeenCalledWith(error, "h1", undefined);
    expect(onSuccess).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(client.getQueryState(keys.harnesses.detail("h1"))?.isInvalidated).toBe(true),
    );
  });

  it("toasts a generic message for errors without one from the server", async () => {
    const { mutationFn, result } = setup({});
    mutationFn.mockRejectedValue(new TypeError("boom"));
    act(() => result.current.mutate("h1"));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(ui.notify).toHaveBeenCalledWith(MUTATION_FAILED, { variant: "danger" });
  });

  it("passes onMutate's context to onError, for rolling back optimistic updates", async () => {
    const onError = vi.fn();
    const { mutationFn, result } = setup({ onMutate: () => ({ previous: "on" }), onError });
    mutationFn.mockRejectedValue(new ApiError("Couldn't save.", 500));
    act(() => result.current.mutate("h1"));
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError).toHaveBeenCalledWith(expect.any(ApiError), "h1", { previous: "on" });
  });

  it("refuses to run once another tab switched organizations, without a toast", async () => {
    guard.stale = true;
    const onMutate = vi.fn();
    const onError = vi.fn();
    const { mutationFn, result } = setup({ onMutate, onError });
    act(() => result.current.mutate("h1"));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mutationFn).not.toHaveBeenCalled();
    expect(onMutate).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(ui.notify).not.toHaveBeenCalled();
  });
});
