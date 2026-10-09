import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { IntegrationsView, type SlackWorkspace } from "./integrations-view";

vi.mock("./actions", () => ({ disconnectLinear: vi.fn(), disconnectSlack: vi.fn() }));
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));

const WORKSPACE: SlackWorkspace = {
  id: "conn-1",
  name: "Acme Slack",
  workspaceId: "T01",
  installedBy: "ada@acme.test",
  connectedAt: "2026-10-02T00:00:00.000Z",
};

function render(slack: SlackWorkspace[], slackConfigured: boolean): string {
  return renderToStaticMarkup(
    <IntegrationsView
      linear={null}
      linearConfigured
      notice={null}
      slack={slack}
      slackConfigured={slackConfigured}
      slackNotice={null}
    />,
  );
}

/** The markup of the Slack card (from its title to the end of the page). */
const slackSection = (html: string) => html.slice(html.indexOf(">Slack<"));

describe("IntegrationsView › Slack", () => {
  it("lists connected workspaces with their installer, a Disconnect button and Connect", () => {
    const html = slackSection(render([WORKSPACE], true));
    expect(html).toContain("Acme Slack");
    expect(html).toContain("by ada@acme.test");
    expect(html).toContain("Disconnect");
    expect(html).toContain('href="/api/integrations/slack/connect"');
    expect(html).not.toContain("Slack app not configured");
  });

  it("shows the not-configured notice and a disabled Connect button without the env vars", () => {
    const html = slackSection(render([], false));
    expect(html).toContain("Slack app not configured");
    expect(html).not.toContain('href="/api/integrations/slack/connect"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Connect Slack/);
  });
});
