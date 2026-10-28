import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { AGENT_UI_RESOURCES } from "../../../src/ui/events.js";
import {
  LIVE_HANDLERS,
  LIVE_LOG_TAIL_SIZE,
  applyLiveChange,
  parseLiveChange,
  type AgentUiResource,
  type LiveHandler,
} from "./invalidations.js";
import { agentKeys } from "./keys.js";

describe("LIVE_HANDLERS", () => {
  it("handles every resource the daemon publishes", () => {
    expect(Object.keys(LIVE_HANDLERS).sort()).toEqual([...AGENT_UI_RESOURCES].sort());
  });

  it("fails typecheck for an unmapped resource", () => {
    const { status } = LIVE_HANDLERS;
    // @ts-expect-error every resource needs a handler
    const incomplete = { status } satisfies Record<AgentUiResource, LiveHandler>;
    expect(incomplete).toBeDefined();
  });

  it("appends logs and transcripts and invalidates everything else", () => {
    const appended = Object.entries(LIVE_HANDLERS)
      .filter(([, handler]) => "append" in handler)
      .map(([resource]) => resource);
    expect(appended.sort()).toEqual(["logs", "transcript"]);
  });
});

describe("applyLiveChange", () => {
  it("keeps the last 2,000 log lines", () => {
    const client = new QueryClient();
    const lines = Array.from({ length: LIVE_LOG_TAIL_SIZE + 5 }, (_, index) => ({
      time: index,
      level: "info",
      msg: `line ${index}`,
      fields: {},
    }));
    applyLiveChange(client, { v: 1, resource: "logs", at: "", data: lines });
    const tail = client.getQueryData<typeof lines>(agentKeys.logs.tail)!;
    expect(tail).toHaveLength(LIVE_LOG_TAIL_SIZE);
    expect(tail[0]!.msg).toBe("line 5");
  });

  it("refetches an attempt whose transcript event carries no lines", () => {
    const client = new QueryClient();
    client.setQueryData(agentKeys.attempts.detail("job-1"), { id: "job-1", events: [] });
    applyLiveChange(client, { v: 1, resource: "transcript", ids: ["job-1"], at: "" });
    expect(client.getQueryState(agentKeys.attempts.detail("job-1"))?.isInvalidated).toBe(true);
  });
});

describe("parseLiveChange", () => {
  it("reads a v1 change of a known resource", () => {
    const change = { v: 1, resource: "storage", at: "2026-10-28T10:00:00Z" };
    expect(parseLiveChange(JSON.stringify(change))).toEqual(change);
  });

  it.each([
    ["not JSON", "{"],
    ["another version", JSON.stringify({ v: 2, resource: "storage", at: "" })],
    ["an unknown resource", JSON.stringify({ v: 1, resource: "fleet", at: "" })],
    ["no object", JSON.stringify("storage")],
  ])("drops %s", (_name, data) => {
    expect(parseLiveChange(data)).toBeNull();
  });
});
