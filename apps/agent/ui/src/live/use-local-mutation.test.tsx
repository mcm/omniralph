// @vitest-environment jsdom
import { Toaster } from "@omniralph/ui";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { localRequest } from "../api.js";
import { createAgentQueryClient } from "../query-client.js";
import { fakeApi } from "../test/page.js";
import { useLocalMutation, type LocalMutationOptions } from "./use-local-mutation.js";

interface Slots {
  slots: number;
}

const KEY = ["capacity"] as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function Capacity({
  options,
}: {
  options: Omit<LocalMutationOptions<Slots, number>, "mutationFn" | "invalidate" | "success">;
}) {
  const query = useQuery({
    queryKey: KEY,
    queryFn: () => localRequest<Slots>("/api/capacity"),
  });
  const mutation = useLocalMutation<Slots, number>({
    mutationFn: (slots) => localRequest<Slots>("/api/capacity", { method: "PUT", body: { slots } }),
    invalidate: () => [KEY],
    success: "Saved",
    ...options,
  });
  return (
    <>
      <p>Slots: {query.data?.slots ?? "…"}</p>
      <button type="button" onClick={() => mutation.mutate(8)}>
        Save
      </button>
      <p>{mutation.isPending ? "Saving" : "Idle"}</p>
    </>
  );
}

function renderCapacity(options: Parameters<typeof Capacity>[0]["options"]) {
  const client = createAgentQueryClient();
  render(
    <QueryClientProvider client={client}>
      <Capacity options={options} />
      <Toaster />
    </QueryClientProvider>,
  );
  return client;
}

const optimistic: Parameters<typeof Capacity>[0]["options"] = {
  optimistic: (slots, cache) => cache.set<Slots>(KEY, () => ({ slots })),
};

describe("useLocalMutation", () => {
  it("shows an optimistic change while the request is pending", async () => {
    const reply = deferred<{ body: Slots }>();
    let saved = 4;
    fakeApi({
      "GET /api/capacity": () => ({ body: { slots: saved } }),
      "PUT /api/capacity": () => reply.promise,
    });
    renderCapacity(optimistic);
    expect(await screen.findByText("Slots: 4")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Slots: 8")).toBeTruthy();
    expect(screen.getByText("Saving")).toBeTruthy();
    saved = 8;
    reply.resolve({ body: { slots: 8 } });
    expect(await screen.findByText("Idle")).toBeTruthy();
    expect(screen.getByText("Slots: 8")).toBeTruthy();
  });

  it("rolls the change back exactly, with a danger toast, when the agent answers 500", async () => {
    const reply = deferred<{ status: number; body: unknown }>();
    const reconcile = deferred<{ body: Slots }>();
    let gets = 0;
    fakeApi({
      "GET /api/capacity": () => {
        gets += 1;
        return gets === 1 ? { body: { slots: 4 } } : reconcile.promise;
      },
      "PUT /api/capacity": () => reply.promise,
    });
    const client = renderCapacity(optimistic);
    expect(await screen.findByText("Slots: 4")).toBeTruthy();
    const before = client.getQueryState(KEY);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Slots: 8")).toBeTruthy();
    reply.resolve({ status: 500, body: { error: "settings.json couldn't be written" } });
    const notifications = screen.getByRole("region", { name: "Notifications" });
    expect(
      await within(notifications).findByText("settings.json couldn't be written"),
    ).toBeTruthy();
    expect(notifications.querySelector(".or-dot--fail")).toBeTruthy();
    expect(screen.getByText("Slots: 4")).toBeTruthy();
    // The exact previous state, until the background reconcile answers.
    const after = client.getQueryState(KEY);
    expect(after?.data).toEqual(before?.data);
    expect(after?.dataUpdatedAt).toBe(before?.dataUpdatedAt);
    expect(gets).toBe(2);
    reconcile.resolve({ body: { slots: 4 } });
    expect(await screen.findByText("Idle")).toBeTruthy();
  });

  it("shows applyResult's answer before the reconcile resolves", async () => {
    const refetch = deferred<{ body: Slots }>();
    let gets = 0;
    fakeApi({
      "GET /api/capacity": () => {
        gets += 1;
        return gets === 1 ? { body: { slots: 4 } } : refetch.promise;
      },
      "PUT /api/capacity": { body: { slots: 6 } },
    });
    renderCapacity({
      applyResult: (data, cache) => cache.set<Slots>(KEY, () => data),
    });
    expect(await screen.findByText("Slots: 4")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    // The agent's answer (6), while the reconcile's refetch is still out.
    expect(await screen.findByText("Slots: 6")).toBeTruthy();
    expect(await screen.findByText("Idle")).toBeTruthy();
    expect(gets).toBe(2);
    expect(
      within(screen.getByRole("region", { name: "Notifications" })).getByText("Saved"),
    ).toBeTruthy();
    refetch.resolve({ body: { slots: 6 } });
    expect(await screen.findByText("Slots: 6")).toBeTruthy();
  });
});
