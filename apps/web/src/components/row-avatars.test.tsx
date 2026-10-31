// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { inboxItemIcon } from "@/screens/inbox/inbox-badges";
import {
  AGENT_ICON,
  BACKGROUND_WORK_ICON,
  CodeHostMark,
  RUN_KIND_ICONS,
  TrackerMark,
} from "./row-avatars";

describe("TrackerMark", () => {
  it("draws Linear's mark for a Linear work item, else Omniralph's", () => {
    const { unmount } = render(<TrackerMark tracker="linear" />);
    expect(screen.getByRole("img", { name: "Linear" })).toBeTruthy();
    unmount();
    render(<TrackerMark tracker="jira" />);
    expect(screen.getByRole("img", { name: "Omniralph" })).toBeTruthy();
  });
});

describe("CodeHostMark", () => {
  it("draws GitHub's or GitLab's mark, else Git's", () => {
    const { unmount } = render(
      <>
        <CodeHostMark provider="github" />
        <CodeHostMark provider="gitlab" />
      </>,
    );
    expect(screen.getByRole("img", { name: "GitHub" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "GitLab" })).toBeTruthy();
    unmount();
    render(<CodeHostMark provider="bitbucket" />);
    expect(screen.getByRole("img", { name: "Git" })).toBeTruthy();
  });
});

describe("inboxItemIcon", () => {
  const run = { id: "r", kind: "review" as const, status: "failed" as const };
  it("shows an agent's item as the agent, a run's as its kind, and the rest as background work", () => {
    expect(inboxItemIcon({ kind: "agent_offline", run: null })).toBe(AGENT_ICON);
    expect(inboxItemIcon({ kind: "agent_update_failed", run: null })).toBe(AGENT_ICON);
    expect(inboxItemIcon({ kind: "failed_run", run })).toBe(RUN_KIND_ICONS.review);
    expect(inboxItemIcon({ kind: "failed_system", run: null })).toBe(BACKGROUND_WORK_ICON);
  });
});
