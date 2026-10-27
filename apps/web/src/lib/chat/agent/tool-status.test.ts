import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { chatTools } = await import("./registry");
const { hasToolStatus, toolStatus, UNKNOWN_TOOL_STATUS } = await import("./tool-status");

describe("toolStatus", () => {
  const names = Object.keys(chatTools);

  it("has a sentence for every chat tool", () => {
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => !hasToolStatus(name))).toEqual([]);
  });

  it("never names a tool, Ralph or the harness", () => {
    const sentences = names.flatMap((name) => [
      toolStatus(name, {}),
      toolStatus(name, { repository: "acme/customer-portal" }),
    ]);
    for (const sentence of sentences) {
      expect(sentence).not.toBe(UNKNOWN_TOOL_STATUS);
      expect(sentence).toMatch(/^[A-Z][^_]*[^.]$/);
      for (const name of names) expect(sentence).not.toContain(name);
      expect(sentence).not.toMatch(/ralph|harness/i);
    }
  });

  it("names the repo a code question reads", () => {
    expect(
      toolStatus("ask_about_code", { repository: "acme/customer-portal", question: "?" }),
    ).toBe("Asking an agent to read customer-portal");
    expect(toolStatus("ask_about_code", { repository: "group/sub/customer-portal" })).toBe(
      "Asking an agent to read customer-portal",
    );
    expect(
      toolStatus("ask_about_code", { repository: "0b7c9f0e-1f1a-4a6b-9a55-1c2d3e4f5a6b" }),
    ).toBe("Asking an agent to read the code");
    expect(toolStatus("ask_about_code", undefined)).toBe("Asking an agent to read the code");
    expect(toolStatus("list_ralph_runs", {})).toBe("Looking at runs");
    expect(toolStatus("draft_request", {})).toBe("Drafting a request");
  });

  it("says Working on it for an unknown tool", () => {
    expect(toolStatus("frobnicate", {})).toBe("Working on it");
    expect(toolStatus("toString", {})).toBe("Working on it");
  });
});
