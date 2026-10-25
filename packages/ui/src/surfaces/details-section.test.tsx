import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DetailsSection } from "./details-section.js";

describe("DetailsSection", () => {
  it("starts closed and opens on summary click", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <DetailsSection>
        <p>Created by Om</p>
      </DetailsSection>,
    );
    const details = container.querySelector("details")!;
    expect(details.className).toBe("or-more-info");
    expect(details.open).toBe(false);
    const summary = screen.getByText("Details");
    expect(summary.tagName).toBe("SUMMARY");
    expect(summary.querySelector("svg.or-more-info__chevron")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    await user.click(summary);
    expect(details.open).toBe(true);
    expect(screen.getByText("Created by Om")).toBeTruthy();
  });

  it("takes a title", () => {
    render(<DetailsSection title="Provenance">From GitLab.</DetailsSection>);
    expect(screen.getByText("Provenance").tagName).toBe("SUMMARY");
  });
});
