import type * as Db from "@omniralph/db";
import type { RepositoryStatusFacts, StatusAgent } from "@omniralph/db";
import { describe, expect, it, vi } from "vitest";
import type { StatusRepository } from "./status";

vi.mock("server-only", () => ({}));
const stub = vi.hoisted(() => ({
  facts: undefined as unknown as RepositoryStatusFacts,
  lastSeen: new Map<string, string>(),
}));
vi.mock("@omniralph/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  loadRepositoryStatusFacts: async () => stub.facts,
}));
vi.mock("@/lib/hot-state", () => ({
  hotStateEnabled: () => true,
  getRedis: () => ({
    mget: async (keys: string[]) => keys.map((key) => stub.lastSeen.get(key) ?? null),
  }),
}));

const { loadRepositoryStatuses, repositoryStatus, REPOSITORY_PROBLEM_ORDER } =
  await import("./status");
const { agentLastSeenKey } = await import("@/lib/agents/last-seen");

const NOW = new Date("2026-10-26T12:00:00.000Z");
const ORG = "org-1";
const REPO = "repo-1";

function agent(id: string, overrides: Partial<StatusAgent> = {}): StatusAgent {
  return {
    id,
    organizationId: ORG,
    name: id,
    lastHeartbeatAt: new Date(NOW.getTime() - 10_000),
    revoked: false,
    ...overrides,
  };
}

function facts(overrides: Partial<RepositoryStatusFacts> = {}): RepositoryStatusFacts {
  return {
    running: new Map(),
    latestSync: new Map(),
    pins: new Map(),
    agents: [agent("online")],
    ...overrides,
  };
}

const github: StatusRepository["connection"] = {
  id: "c1",
  provider: "github",
  baseUrl: "",
  health: null,
};
const repository = (connection: StatusRepository["connection"] = github) => ({
  id: REPO,
  organizationId: ORG,
  connection,
});

describe("repositoryStatus", () => {
  it("is quiet for a healthy repo, and counts its running work", () => {
    expect(repositoryStatus(repository(), facts(), NOW)).toEqual({ running: 0, problems: [] });
    expect(repositoryStatus(repository(), facts({ running: new Map([[REPO, 3]]) }), NOW)).toEqual({
      running: 3,
      problems: [],
    });
  });

  it("lists problems in the order webhook, sync_failed, no_agent_online, connection", () => {
    const gitlab = {
      id: "c2",
      provider: "gitlab" as const,
      baseUrl: "https://gitlab.example.com",
      health: {
        checkedAt: NOW.toISOString(),
        tokenExpiresAt: null,
        problems: [
          { code: "token_invalid", message: "GitLab rejects the bot token." },
          { code: "webhook_events_outdated", message: "Outdated webhook.", repositoryId: REPO },
        ],
      },
    };
    const status = repositoryStatus(
      repository(gitlab),
      facts({
        latestSync: new Map([
          [REPO, { repositoryId: REPO, jobId: "job-1", status: "failed" as const, agent: null }],
        ]),
        agents: [agent("stale", { lastHeartbeatAt: new Date(NOW.getTime() - 3_600_000) })],
      }),
      NOW,
    );
    expect(status.problems.map((p) => p.code)).toEqual(REPOSITORY_PROBLEM_ORDER);
    expect(status.problems[1]!.message).toBe("Couldn't update this repo's checkout.");
    // With none pinned, Open agent goes to the agent heard from last.
    expect(status.problems[2]!.action).toEqual({
      type: "link",
      label: "Open agent",
      href: "/fleet/stale",
    });
  });

  it("only counts pinned agents when the repo has pins, and revoked ones are never online", () => {
    const pins = new Map([[REPO, ["pinned"]]]);
    const offlinePin = agent("pinned", { lastHeartbeatAt: null });
    expect(
      repositoryStatus(repository(), facts({ pins, agents: [agent("online"), offlinePin] }), NOW)
        .problems,
    ).toEqual([
      {
        code: "no_agent_online",
        message: "No agent online",
        action: { type: "link", label: "Open agent", href: "/fleet/pinned" },
      },
    ]);
    expect(
      repositoryStatus(repository(), facts({ agents: [agent("gone", { revoked: true })] }), NOW)
        .problems,
    ).toEqual([{ code: "no_agent_online", message: "No agent online" }]);
    // Another organization's online agent doesn't serve this repo.
    expect(
      repositoryStatus(
        repository(),
        facts({ agents: [agent("elsewhere", { organizationId: "org-2" })] }),
        NOW,
      ).problems.map((p) => p.code),
    ).toEqual(["no_agent_online"]);
  });

  it("isn't a connection problem when the token is only expiring", () => {
    const gitlab = {
      id: "c3",
      provider: "gitlab" as const,
      baseUrl: "https://gitlab.example.com",
      health: {
        checkedAt: NOW.toISOString(),
        tokenExpiresAt: "2026-10-28",
        problems: [{ code: "token_expiring", message: "Expires soon." }],
      },
    };
    expect(repositoryStatus(repository(gitlab), facts(), NOW).problems).toEqual([]);
  });
});

describe("loadRepositoryStatuses", () => {
  const db = {} as Parameters<typeof loadRepositoryStatuses>[0];
  const stale = { lastHeartbeatAt: new Date(NOW.getTime() - 3600_000) };

  it("counts an agent online from its Redis last-seen when its row's heartbeat is stale", async () => {
    stub.facts = facts({ agents: [agent("a1", stale)], pins: new Map([[REPO, ["a1"]]]) });
    stub.lastSeen = new Map([[agentLastSeenKey("a1"), String(NOW.getTime() - 5_000)]]);

    const statuses = await loadRepositoryStatuses(db, [repository()], NOW);

    expect(statuses.get(REPO)).toEqual({ running: 0, problems: [] });
  });

  it("still reports no agent online when neither Redis nor the row has a recent heartbeat", async () => {
    stub.facts = facts({ agents: [agent("a1", stale)] });
    stub.lastSeen = new Map([[agentLastSeenKey("a1"), String(NOW.getTime() - 120_000)]]);

    const statuses = await loadRepositoryStatuses(db, [repository()], NOW);

    expect(statuses.get(REPO)?.problems.map((p) => p.code)).toEqual(["no_agent_online"]);
  });
});
