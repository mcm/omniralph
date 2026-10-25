import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createTestQueryClient, queryWrapper } from "@/components/query-test-utils";
import type { IntegrationsSettings } from "@/lib/api/integrations";
import type { ChatPlaybooksSettings } from "@/lib/api/integrations";
import { type DiscordServer, IntegrationsContent, type SlackWorkspace } from "./integrations-view";

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

const chatPlaybooks: ChatPlaybooksSettings = {
  defaults: { ask: "builtin:ask-about-code", startWork: "builtin:handle-request" },
  builtinDefaults: { ask: "builtin:ask-about-code", startWork: "builtin:handle-request" },
  choices: {
    ask: [{ id: "builtin:ask-about-code", name: "Ask about code", builtin: true }],
    startWork: [{ id: "builtin:handle-request", name: "Handle a request", builtin: true }],
  },
  connections: [],
};

function render(
  slack: SlackWorkspace[],
  slackConfigured: boolean,
  discord: DiscordServer[] = [],
  discordConfigured = true,
): string {
  return renderContent({
    linear: null,
    linearConfigured: true,
    slack,
    slackConfigured,
    discord,
    discordConfigured,
    chatPlaybooks,
  });
}

function renderContent(settings: IntegrationsSettings): string {
  const Wrapper = queryWrapper(createTestQueryClient());
  return renderToStaticMarkup(
    <Wrapper>
      <IntegrationsContent {...settings} />
    </Wrapper>,
  );
}

/** The markup of the Slack card (from its title to the Discord card). */
const slackSection = (html: string) =>
  html.slice(html.indexOf(">Slack<"), html.indexOf(">Discord<"));
/** The markup of the Discord card (from its title to the end of the page). */
const discordSection = (html: string) => html.slice(html.indexOf(">Discord<"));

describe("IntegrationsContent › Slack", () => {
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

describe("IntegrationsContent › connected but not configured", () => {
  it("explains a saved Slack connection whose app credentials are missing", () => {
    const html = slackSection(render([WORKSPACE], false));
    expect(html).toContain("Connected, but the Slack app isn&#x27;t configured");
    expect(html).toContain("mentions in Slack are ignored");
    expect(html).not.toContain("Slack app not configured");
  });

  it("explains a connected Linear workspace without the Linear app credentials", () => {
    const html = renderContent({
      linear: { name: "Acme", workspaceId: "W01", connectedAt: "2026-10-01T00:00:00.000Z" },
      linearConfigured: false,
      slack: [],
      slackConfigured: true,
      discord: [],
      discordConfigured: true,
      chatPlaybooks,
    });
    const linear = html.slice(0, html.indexOf(">Slack<"));
    expect(linear).toContain("Connected, but the Linear app isn&#x27;t configured");
    expect(linear).toContain("delegations from Linear are rejected");
    expect(linear).not.toContain("Linear app not configured");
  });
});

describe("IntegrationsContent › Discord", () => {
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

describe("IntegrationsContent › chat playbooks", () => {
  it("has no Chat tasks or Channel tasks card (chat playbook choice is an advanced setting)", () => {
    const html = renderContent({
      linear: null,
      linearConfigured: true,
      slack: [WORKSPACE],
      slackConfigured: true,
      discord: [SERVER],
      discordConfigured: true,
      chatPlaybooks: {
        ...chatPlaybooks,
        connections: [
          {
            id: "conn-1",
            name: "Acme Slack",
            platform: "slack",
            channels: [{ channelId: "slack:C0OPS", channel: "C0OPS", ask: null, startWork: "x" }],
          },
        ],
      },
    });
    expect(html).not.toContain("Chat tasks");
    expect(html).not.toContain("Channel tasks");
    expect(html).not.toContain("C0OPS");
    expect(html).not.toContain("chat-task-");
    expect(html).not.toContain("chat-channel-");
  });
});
