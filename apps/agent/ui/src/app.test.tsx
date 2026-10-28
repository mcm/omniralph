// @vitest-environment jsdom
import { act, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { localRequest } from "./api.js";
import { agentState, fakeApi, fakeEventSources, renderAgentPage } from "./test/page.js";

const REOPEN =
  "The agent restarted, so this page's link no longer works. Run omniralph-agent ui on the machine to get a new one.";

describe("a 401", () => {
  it("replaces the whole page with Open this page again", async () => {
    fakeApi({ "/api/state": { status: 401, body: { error: "Open this page again" } } });
    const streams = fakeEventSources();
    renderAgentPage({ createEventSource: streams.create });
    expect(
      await screen.findByRole("heading", { level: 1, name: "Open this page again" }),
    ).toBeTruthy();
    expect(screen.getByText((_, element) => element?.textContent === REOPEN)).toBeTruthy();
    expect(screen.getByText("omniralph-agent ui").tagName).toBe("CODE");
    expect(screen.queryByRole("navigation", { name: "Agent" })).toBeNull();
    // Nothing left to keep current.
    expect(streams.latest().closed).toBe(true);
  });

  it("from any request, after the page was working", async () => {
    let status = 200;
    fakeApi({
      "/api/state": { body: agentState() },
      "PUT /api/settings/capacity": () => ({ status, body: { error: "Unauthorized" } }),
    });
    renderAgentPage({ path: "/capacity" });
    expect(await screen.findByText("build-01")).toBeTruthy();
    status = 401;
    await act(async () => {
      await localRequest("/api/settings/capacity", { method: "PUT", body: {} }).catch(() => {});
    });
    expect(screen.getByRole("heading", { name: "Open this page again" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Capacity" })).toBeNull();
    // It stays: only a new link fixes it.
    await userEvent.click(document.body);
    expect(screen.getByRole("heading", { name: "Open this page again" })).toBeTruthy();
  });
});
