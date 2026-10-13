import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ChatTasksSettings } from "./chat-tasks-card";
import { type DiscordServer, IntegrationsView, type SlackWorkspace } from "./integrations-view";

vi.mock("./actions", () => ({
  disconnectLinear: vi.fn(),
  disconnectSlack: vi.fn(),
  disconnectDiscord: vi.fn(),
  saveChatTaskDefaults: vi.fn(),
  saveChatChannelTasks: vi.fn(),
  removeChatChannelTasks: vi.fn(),
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

let chatTasks: ChatTasksSettings = {
  defaults: { askAboutCode: "builtin:ask-about-code", startWork: "builtin:handle-request" },
  builtinDefaults: { askAboutCode: "builtin:ask-about-code", startWork: "builtin:handle-request" },
  choices: {
    askAboutCode: [{ id: "builtin:ask-about-code", name: "Ask about code", builtin: true }],
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
      chatTasks={chatTasks}
    />,
  );
}

/** The markup of the Slack card (from its title to the Discord card). */
const slackSection = (html: string) =>
  html.slice(html.indexOf(">Slack<"), html.indexOf(">Discord<"));
/** The markup of the Discord card (from its title to the chat tasks card). */
const discordSection = (html: string) =>
  html.slice(html.indexOf(">Discord<"), html.indexOf(">Chat tasks<"));
/** The markup of the chat tasks card (to the end of the page). */
const chatTasksSection = (html: string) => html.slice(html.indexOf(">Chat tasks<"));

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

describe("IntegrationsView › connected but not configured", () => {
  it("explains a saved Slack connection whose app credentials are missing", () => {
    const html = slackSection(render([WORKSPACE], false));
    expect(html).toContain("Connected, but the Slack app isn&#x27;t configured");
    expect(html).toContain("mentions in Slack are ignored");
    expect(html).not.toContain("Slack app not configured");
  });

  it("explains a connected Linear workspace without the Linear app credentials", () => {
    const html = renderToStaticMarkup(
      <IntegrationsView
        linear={{ name: "Acme", workspaceId: "W01", connectedAt: "2026-10-01T00:00:00.000Z" }}
        linearConfigured={false}
        notice={null}
        slack={[]}
        slackConfigured
        slackNotice={null}
        discord={[]}
        discordConfigured
        discordNotice={null}
        chatTasks={chatTasks}
      />,
    );
    const linear = html.slice(0, html.indexOf(">Slack<"));
    expect(linear).toContain("Connected, but the Linear app isn&#x27;t configured");
    expect(linear).toContain("delegations from Linear are rejected");
    expect(linear).not.toContain("Linear app not configured");
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

describe("IntegrationsView › Chat tasks", () => {
  it("shows the organization's tasks and each connection's channel overrides", () => {
    chatTasks = {
      ...chatTasks,
      defaults: { askAboutCode: "builtin:ask-about-code", startWork: "builtin:gone" },
      connections: [
        {
          id: "conn-1",
          name: "Acme Slack",
          platform: "slack",
          channels: [
            {
              channelId: "slack:C0SECURITY",
              channel: "C0SECURITY",
              askAboutCode: null,
              startWork: "builtin:handle-request",
            },
          ],
        },
        { id: "conn-2", name: "Acme Discord", platform: "discord", channels: [] },
      ],
    };
    const html = chatTasksSection(render([], true));
    expect(html).toContain("Ask about code");
    expect(html).toContain("Handle a request");
    // A chosen task that's no longer a choice stays listed.
    expect(html).toContain("builtin:gone (unavailable)");
    expect(html).toContain("C0SECURITY");
    expect(html).toContain("Remove");
    expect(html).toContain("Slack channel ID");
    expect(html).toContain("Discord channel ID");
    expect(html).toContain("No channel runs different tasks.");
  });
});

describe("IntegrationsView › Chat tasks › custom tasks", () => {
  const QUERY = "11111111-1111-4111-8111-111111111111";
  const CODING = "22222222-2222-4222-8222-222222222222";

  /** The `<select>` with `id` and its options (up to its end). */
  const select = (html: string, id: string) => {
    const start = html.search(new RegExp(`<select[^>]*id="${id}"`));
    expect(start).toBeGreaterThan(-1);
    return html.slice(start, html.indexOf("</select>", start));
  };

  it("lists the organization's own tasks in every picker, selected where chosen", () => {
    chatTasks = {
      ...chatTasks,
      defaults: { askAboutCode: QUERY, startWork: "builtin:handle-request" },
      choices: {
        askAboutCode: [
          { id: "builtin:ask-about-code", name: "Ask about code", builtin: true },
          { id: QUERY, name: "Security Q and A", builtin: false },
        ],
        startWork: [
          { id: "builtin:handle-request", name: "Handle a request", builtin: true },
          { id: CODING, name: "Hotfix", builtin: false },
        ],
      },
      connections: [
        {
          id: "conn-1",
          name: "Acme Slack",
          platform: "slack",
          channels: [
            { channelId: "slack:C0OPS", channel: "C0OPS", askAboutCode: null, startWork: CODING },
          ],
        },
      ],
    };
    const html = chatTasksSection(render([], true));
    const pickers = [
      "chat-task-askAboutCode",
      "chat-task-startWork",
      "chat-channel-conn-1-C0OPS-askAboutCode",
      "chat-channel-conn-1-C0OPS-startWork",
      "chat-channel-conn-1-askAboutCode",
      "chat-channel-conn-1-startWork",
    ];
    for (const id of pickers) {
      const options = select(html, id);
      if (id.endsWith("askAboutCode")) {
        expect(options).toContain("Ask about code (built-in)");
        expect(options).toContain(`value="${QUERY}"`);
        expect(options).toContain(">Security Q and A<");
        expect(options).not.toContain(CODING);
      } else {
        expect(options).toContain("Handle a request (built-in)");
        expect(options).toContain(`value="${CODING}"`);
        expect(options).toContain(">Hotfix<");
        expect(options).not.toContain(QUERY);
      }
      expect(options).not.toContain("(unavailable)");
    }
    expect(select(html, "chat-task-askAboutCode")).toMatch(
      new RegExp(`<option value="${QUERY}" selected="">`),
    );
    expect(select(html, "chat-channel-conn-1-C0OPS-startWork")).toMatch(
      new RegExp(`<option value="${CODING}" selected="">`),
    );
  });
});
