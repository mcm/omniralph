import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { type DiscordServer, IntegrationsView, type SlackWorkspace } from "./integrations-view";

vi.mock("./actions", () => ({
  disconnectLinear: vi.fn(),
  disconnectSlack: vi.fn(),
  disconnectDiscord: vi.fn(),
}));
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));

const WORKSPACE: SlackWorkspace = {
  id: "conn-1",
  name: "Acme Slack",
  workspaceId: "T01",
  installedBy: "ada@acme.test",
  connectedAt: "2026-10-02T00:00:00.000Z",
};

const SERVER: DiscordServer = {
  id: "conn-2",
  name: "Acme Discord",
  serverId: "G01",
  installedBy: "grace@acme.test",
  connectedAt: "2026-10-03T00:00:00.000Z",
};

function render(
  slack: SlackWorkspace[],
  slackConfigured: boolean,
  discord: DiscordServer[] = [],
  discordConfigured = true,
): string {
  return renderToStaticMarkup(
    <IntegrationsView
      linear={null}
      linearConfigured
      notice={null}
      slack={slack}
      slackConfigured={slackConfigured}
      slackNotice={null}
      discord={discord}
      discordConfigured={discordConfigured}
      discordNotice={null}
    />,
  );
}

/** The markup of the Slack card (from its title to the Discord card). */
const slackSection = (html: string) =>
  html.slice(html.indexOf(">Slack<"), html.indexOf(">Discord<"));
/** The markup of the Discord card (from its title to the end of the page). */
const discordSection = (html: string) => html.slice(html.indexOf(">Discord<"));

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

describe("IntegrationsView › Discord", () => {
  it("lists connected servers with their installer, a Disconnect button and Connect", () => {
    const html = discordSection(render([], true, [SERVER], true));
    expect(html).toContain("Acme Discord");
    expect(html).toContain("by grace@acme.test");
    expect(html).toContain("Disconnect");
    expect(html).toContain('href="/api/integrations/discord/connect"');
    expect(html).toContain("Connect another server");
    expect(html).not.toContain("Discord app not configured");
  });

  it("shows the not-configured notice and a disabled Connect button without the env vars", () => {
    const html = discordSection(render([WORKSPACE], true, [], false));
    expect(html).toContain("Discord app not configured");
    expect(html).toContain("DISCORD_PUBLIC_KEY");
    expect(html).not.toContain('href="/api/integrations/discord/connect"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Connect Discord/);
    // Slack stays connectable.
    expect(slackSection(render([WORKSPACE], true, [], false))).toContain(
      'href="/api/integrations/slack/connect"',
    );
  });
});
