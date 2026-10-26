// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AttemptOutcome, ERROR_PREVIEW_LINES } from "./attempt-outcome";

describe("AttemptOutcome", () => {
  it("shows the status dot, the label and the error in mono", () => {
    const { container } = render(
      <AttemptOutcome
        attempt={{
          status: "failed",
          label: "Couldn't build TOOL-2",
          error: "Tests failed\n3 of 40",
        }}
      />,
    );
    expect(screen.getByRole("img", { name: "Failed" }).className).toContain("or-dot--fail");
    expect(screen.getByText("Couldn't build TOOL-2")).toBeTruthy();
    const error = container.querySelector("pre")!;
    expect(error.className).toContain("or-mono");
    expect(error.textContent).toBe("Tests failed\n3 of 40");
    expect(screen.queryByRole("button", { name: "Show all" })).toBeNull();
  });

  it("names each status's dot", () => {
    const { rerender } = render(
      <AttemptOutcome attempt={{ status: "completed", label: "Built TOOL-1", error: null }} />,
    );
    expect(screen.getByRole("img", { name: "Finished" }).className).toContain("or-dot--good");
    rerender(<AttemptOutcome attempt={{ status: "running", label: "Building", error: null }} />);
    expect(screen.getByRole("img", { name: "Running" }).className).toContain("or-dot--run");
    rerender(<AttemptOutcome attempt={{ status: "canceled", label: "Building", error: null }} />);
    expect(screen.getByRole("img", { name: "Canceled" }).className).toContain("or-dot--neutral");
  });

  it("shows no error block without an error", () => {
    const { container } = render(
      <AttemptOutcome attempt={{ status: "completed", label: "Built TOOL-1", error: null }} />,
    );
    expect(container.querySelector("pre")).toBeNull();
  });

  it("shows the first 20 lines of a long error, then all of it on Show all", async () => {
    const user = userEvent.setup();
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const { container } = render(
      <AttemptOutcome attempt={{ status: "failed", label: "Crashed", error: lines.join("\n") }} />,
    );
    const error = () => container.querySelector("pre")!.textContent!.split("\n");
    expect(error()).toEqual(lines.slice(0, ERROR_PREVIEW_LINES));
    await user.click(screen.getByRole("button", { name: "Show all" }));
    expect(error()).toEqual(lines);
    expect(screen.queryByRole("button", { name: "Show all" })).toBeNull();
  });
});
