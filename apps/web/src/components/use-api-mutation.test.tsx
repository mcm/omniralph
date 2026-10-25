// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type * as OmniralphUi from "@omniralph/ui";
import { QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { queryKeys } from "@/lib/api/keys";
import { createTestQueryClient, queryWrapper, TEST_ORGANIZATION_ID } from "./query-test-utils";
import { MUTATION_FAILED, useApiMutation } from "./use-api-mutation";

const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: ui.toast,
}));
const guard = vi.hoisted(() => ({ stale: false }));
vi.mock("./organization-guard", () => ({ useIsOrganizationStale: () => () => guard.stale }));

const keys = queryKeys(TEST_ORGANIZATION_ID);

beforeEach(() => {
  ui.toast.mockReset();
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
    expect(ui.toast).toHaveBeenCalledWith("Harness renamed");
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
    expect(ui.toast).toHaveBeenCalledTimes(1);
    expect(ui.toast).toHaveBeenCalledWith("Renamed, but offline.", { variant: "warning" });
  });

  it("builds the success toast from the result, or shows none", async () => {
    const first = setup<{ ok: true; name: string }>({
      success: (data, name) => `Renamed ${name} to ${data.name}`,
    });
    first.mutationFn.mockResolvedValue({ ok: true, name: "build-02" });
    await act(() => first.result.current.mutateAsync("build-01"));
    expect(ui.toast).toHaveBeenCalledWith("Renamed build-01 to build-02");

    ui.toast.mockReset();
    const second = setup({ success: null });
    second.mutationFn.mockResolvedValue({ ok: true } as never);
    await act(() => second.result.current.mutateAsync("x"));
    expect(ui.toast).not.toHaveBeenCalled();
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
    expect(ui.toast).toHaveBeenCalledWith("That name is taken.", { variant: "danger" });
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
    expect(ui.toast).toHaveBeenCalledWith(MUTATION_FAILED, { variant: "danger" });
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
    expect(ui.toast).not.toHaveBeenCalled();
  });

  describe("optimistic", () => {
    type Harness = { name: string };

    it("shows the change while the request is pending", async () => {
      let finish: (value: unknown) => void = () => {};
      const { client, mutationFn, result } = setup({
        optimistic: (name, cache) =>
          cache.set<Harness>(keys.harnesses.detail("h1"), (previous) => ({ ...previous, name })),
      });
      client.setQueryData<Harness>(keys.harnesses.detail("h1"), { name: "build-01" });
      mutationFn.mockReturnValue(new Promise((resolve) => (finish = resolve)) as never);

      act(() => result.current.mutate("build-02"));
      await waitFor(() => expect(mutationFn).toHaveBeenCalled());
      expect(client.getQueryData(keys.harnesses.detail("h1"))).toEqual({ name: "build-02" });
      await act(async () => finish({ ok: true }));
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(client.getQueryData(keys.harnesses.detail("h1"))).toEqual({ name: "build-02" });
    });

    it("cancels an in-flight fetch so it can't overwrite the change", async () => {
      const { client, mutationFn, result } = setup({
        optimistic: (name, cache) =>
          cache.set<Harness>(keys.harnesses.detail("h1"), () => ({ name })),
      });
      client.setQueryData<Harness>(keys.harnesses.detail("h1"), { name: "build-01" });
      const unsubscribe = new QueryObserver(client, {
        queryKey: keys.harnesses.detail("h1"),
        queryFn: () => new Promise<Harness>(() => {}),
      }).subscribe(() => {});
      await waitFor(() =>
        expect(client.getQueryState(keys.harnesses.detail("h1"))?.fetchStatus).toBe("fetching"),
      );
      mutationFn.mockReturnValue(new Promise(() => {}) as never);
      act(() => result.current.mutate("build-02"));
      await waitFor(() => expect(mutationFn).toHaveBeenCalled());
      expect(client.getQueryState(keys.harnesses.detail("h1"))?.fetchStatus).toBe("idle");
      expect(client.getQueryData(keys.harnesses.detail("h1"))).toEqual({ name: "build-02" });
      unsubscribe();
    });

    it("rolls back to the exact previous data on a 500, with the danger toast", async () => {
      const onError = vi.fn();
      const { client, mutationFn, result } = setup({
        onError,
        optimistic: async (name, cache) => {
          await cache.set<Harness[]>(keys.harnesses.lists, (previous) =>
            previous?.map(() => ({ name })),
          );
          await cache.set<Harness>(keys.harnesses.detail("h1"), () => ({ name }));
          // Not cached before: removed again on rollback.
          await cache.set<Harness>(keys.harnesses.detail("h2"), () => ({ name }));
        },
      });
      const list = [{ name: "build-01" }];
      const detail = { name: "build-01" };
      client.setQueryData(keys.harnesses.list({ page: 1 }), list);
      client.setQueryData(keys.harnesses.list({ page: 2 }), list);
      client.setQueryData(keys.harnesses.detail("h1"), detail);
      const before = {
        page1: client.getQueryState(keys.harnesses.list({ page: 1 })),
        detail: client.getQueryState(keys.harnesses.detail("h1")),
      };

      mutationFn.mockRejectedValue(new ApiError("Couldn't save.", 500));
      act(() => result.current.mutate("build-02"));
      await waitFor(() => expect(result.current.isError).toBe(true));

      expect(client.getQueryData(keys.harnesses.list({ page: 1 }))).toBe(list);
      expect(client.getQueryData(keys.harnesses.list({ page: 2 }))).toBe(list);
      expect(client.getQueryData(keys.harnesses.detail("h1"))).toBe(detail);
      expect(client.getQueryState(keys.harnesses.list({ page: 1 }))?.dataUpdatedAt).toBe(
        before.page1?.dataUpdatedAt,
      );
      expect(client.getQueryState(keys.harnesses.detail("h1"))?.dataUpdatedAt).toBe(
        before.detail?.dataUpdatedAt,
      );
      expect(
        client.getQueryCache().find({ queryKey: keys.harnesses.detail("h2") }),
      ).toBeUndefined();
      expect(ui.toast).toHaveBeenCalledWith("Couldn't save.", { variant: "danger" });
      expect(onError).toHaveBeenCalledWith(expect.any(ApiError), "build-02", undefined);
    });

    it("reconciles in the background after success, without blocking onSuccess", async () => {
      const order: string[] = [];
      const { client, mutationFn, result } = setup({
        optimistic: (name, cache) =>
          cache.set<Harness>(keys.harnesses.detail("h1"), () => ({ name })),
        onSuccess: () => order.push("onSuccess"),
      });
      let release: () => void = () => {};
      const unsubscribe = new QueryObserver(client, {
        queryKey: keys.harnesses.list(),
        queryFn: async () => {
          order.push("refetch started");
          await new Promise<void>((resolve) => (release = resolve));
          order.push("refetched");
          return ["new"];
        },
      }).subscribe(() => {});
      await waitFor(() => expect(order).toEqual(["refetch started"]));
      release();
      await waitFor(() => expect(order).toEqual(["refetch started", "refetched"]));
      order.length = 0;

      mutationFn.mockResolvedValue({ ok: true } as never);
      await act(() => result.current.mutateAsync("build-02"));
      // onSuccess ran while the reconcile refetch is still pending.
      expect(order).toEqual(["refetch started", "onSuccess"]);
      expect(client.getQueryState(keys.harnesses.list())?.isInvalidated).toBe(true);
      release();
      await waitFor(() => expect(order).toContain("refetched"));
      unsubscribe();
    });

    it("rolls back what it wrote when the optimistic update itself throws", async () => {
      const { client, mutationFn, result } = setup({
        optimistic: async (name, cache) => {
          await cache.set<Harness>(keys.harnesses.detail("h1"), () => ({ name }));
          throw new Error("bad update");
        },
      });
      const detail = { name: "build-01" };
      client.setQueryData(keys.harnesses.detail("h1"), detail);
      act(() => result.current.mutate("build-02"));
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(mutationFn).not.toHaveBeenCalled();
      expect(client.getQueryData(keys.harnesses.detail("h1"))).toBe(detail);
    });

    it("rolls back the optimistic update when the caller's onMutate throws", async () => {
      const { client, mutationFn, result } = setup({
        optimistic: (name, cache) => cache.set<Harness>(keys.harnesses.detail("h1"), () => ({ name })),
        onMutate: async () => {
          throw new Error("bad context");
        },
      });
      const detail = { name: "build-01" };
      client.setQueryData(keys.harnesses.detail("h1"), detail);
      act(() => result.current.mutate("build-02"));
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(mutationFn).not.toHaveBeenCalled();
      expect(client.getQueryData(keys.harnesses.detail("h1"))).toBe(detail);
    });
  });

  describe("applyResult", () => {
    it("writes the server's response into the cache before onSuccess", async () => {
      let seenInOnSuccess: unknown;
      const { client, mutationFn, result } = setup<{ ok: true; id: string; name: string }>({
        applyResult: (data, cache) =>
          cache.set(cache.keys.harnesses.detail(data.id), () => ({ name: data.name })),
        onSuccess: () => {
          seenInOnSuccess = client.getQueryData(keys.harnesses.detail("h9"));
        },
      });
      mutationFn.mockResolvedValue({ ok: true, id: "h9", name: "build-09" });
      await act(() => result.current.mutateAsync("build-09"));
      expect(client.getQueryData(keys.harnesses.detail("h9"))).toEqual({ name: "build-09" });
      expect(seenInOnSuccess).toEqual({ name: "build-09" });
    });

    it("reconciles in the background: the mutation doesn't wait on the refetch", async () => {
      const { client, mutationFn, result } = setup({
        applyResult: (_data, cache) =>
          cache.set(cache.keys.harnesses.detail("h1"), () => ({ name: "saved" })),
      });
      const unsubscribe = new QueryObserver(client, {
        queryKey: keys.harnesses.list(),
        queryFn: () => new Promise(() => {}),
      }).subscribe(() => {});
      mutationFn.mockResolvedValue({ ok: true } as never);
      // Resolves although the invalidated list's refetch never finishes.
      await act(() => result.current.mutateAsync("h1"));
      expect(client.getQueryState(keys.harnesses.list())?.isInvalidated).toBe(true);
      unsubscribe();
    });
  });
});
