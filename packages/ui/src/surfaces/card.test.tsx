import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Button } from "../actions/button.js";
import { Card } from "./card.js";

describe("Card", () => {
  it("renders a section labeled by its title, with its children", () => {
    render(
      <Card title="Default branch">
        <p>main</p>
      </Card>,
    );
    const card = screen.getByRole("region", { name: "Default branch" });
    expect(card.tagName).toBe("SECTION");
    expect(within(card).getByRole("heading", { level: 2, name: "Default branch" })).toBeTruthy();
    expect(within(card).getByText("main")).toBeTruthy();
    expect(within(card).queryByRole("button")).toBeNull();
  });

  it("takes the heading level", () => {
    render(<Card title="Agents" headingLevel={3} />);
    expect(screen.getByRole("heading", { level: 3, name: "Agents" })).toBeTruthy();
  });

  it("can be the page's own heading", () => {
    render(<Card title="Sign in" headingLevel={1} />);
    expect(screen.getByRole("region", { name: "Sign in" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Sign in" })).toBeTruthy();
  });

  it("puts the info button right after the title and the actions after it", async () => {
    const user = userEvent.setup();
    render(
      <Card title="Usage" info="Counted from run transcripts." actions={<Button>Export</Button>}>
        <p>12 runs</p>
      </Card>,
    );
    const card = screen.getByRole("region", { name: "Usage" });
    const heading = within(card).getByRole("heading", { name: "Usage" });
    const info = within(card).getByRole("button", { name: "About this card" });
    const action = within(card).getByRole("button", { name: "Export" });
    expect(heading.nextElementSibling).toBe(info);
    expect(info.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(action.closest(".or-card__actions")).toBeTruthy();

    await user.click(info);
    expect((await screen.findByRole("dialog", { name: "About this card" })).textContent).toBe(
      "Counted from run transcripts.",
    );
  });

  it("names the info button with infoLabel", () => {
    render(<Card title="Usage" info="From transcripts." infoLabel="About usage" />);
    expect(screen.getByRole("button", { name: "About usage" })).toBeTruthy();
  });
});
