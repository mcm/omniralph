import { IconInbox } from "@tabler/icons-react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "../actions/button.js";
import { EmptyState, type EmptyStateProps } from "./empty-state.js";

describe("EmptyState", () => {
  it("renders the heading alone", () => {
    const { container } = render(<EmptyState title="Nothing needs you" />);
    expect(screen.getByRole("heading", { level: 2, name: "Nothing needs you" })).toBeTruthy();
    expect(container.querySelector("p")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders the description", () => {
    render(<EmptyState title="No runs" description="Runs show here once Om starts one." />);
    expect(screen.getByText("Runs show here once Om starts one.").tagName).toBe("P");
  });

  it("renders the action", () => {
    render(<EmptyState title="No repositories" action={<Button>Add repository</Button>} />);
    expect(screen.getByRole("button", { name: "Add repository" })).toBeTruthy();
  });

  it("takes the heading level and a decorative icon", () => {
    const { container } = render(
      <EmptyState title="Inbox zero" headingLevel={3} icon={IconInbox} />,
    );
    expect(screen.getByRole("heading", { level: 3, name: "Inbox zero" })).toBeTruthy();
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("has no hint prop", () => {
    // @ts-expect-error EmptyState carries no hint text about where things are.
    const props: EmptyStateProps = { title: "Empty", hint: "Use the sidebar" };
    expect(props.title).toBe("Empty");
  });
});
