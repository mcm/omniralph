import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LIVE_NOTICE_MESSAGE, LiveNotice } from "./live-notice.js";

describe("LiveNotice", () => {
  it("is a status that says live updates stopped", () => {
    render(<LiveNotice onRetry={() => {}} />);
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Live updates stopped. Retrying…");
    expect(LIVE_NOTICE_MESSAGE).toBe("Live updates stopped. Retrying…");
  });

  it("draws a neutral dot, never the accent or coral", () => {
    render(<LiveNotice onRetry={() => {}} />);
    expect(document.querySelector(".or-live-notice .or-dot")?.className).toBe(
      "or-dot or-dot--neutral",
    );
  });
});
