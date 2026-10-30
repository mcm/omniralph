import { isValidElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { FleetView } from "@/screens/fleet/fleet-view";
import FleetAgentPage from "./[id]/page";
import FleetPage from "./page";

const AGENT_ID = "6f1c2a59-2a5c-4a8e-9f0a-1d2b3c4d5e6f";

describe("the Fleet pages", () => {
  it("renders Fleet without an agent on /fleet", () => {
    const page = FleetPage() as ReactElement<{ agentId?: string }>;
    expect(isValidElement(page)).toBe(true);
    expect(page.type).toBe(FleetView);
    expect(page.props.agentId).toBeUndefined();
  });

  it("renders Fleet with the agent selected on /fleet/{id}", async () => {
    const page = (await FleetAgentPage({
      params: Promise.resolve({ id: AGENT_ID }),
    })) as ReactElement<{ agentId?: string }>;
    expect(page.type).toBe(FleetView);
    expect(page.props.agentId).toBe(AGENT_ID);
  });
});
