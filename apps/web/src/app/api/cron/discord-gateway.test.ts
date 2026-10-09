import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DISCORD_GATEWAY_CRON_MINUTES,
  DISCORD_GATEWAY_CRON_SCHEDULE,
  DISCORD_GATEWAY_LISTEN_SECONDS,
  DISCORD_GATEWAY_MAX_DURATION_SECONDS,
} from "@/lib/chat/discord-gateway";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  configured: true,
  initialized: 0,
  afterTasks: [] as unknown[],
  listeners: [] as Array<{ durationMs?: number; abortSignal?: AbortSignal; webhookUrl?: string }>,
}));
vi.mock("next/server", () => ({
  after: (task: unknown) => {
    state.afterTasks.push(task);
  },
}));
vi.mock("@/lib/chat/discord-oauth", () => ({
  discordOAuthConfig: () =>
    state.configured
      ? { applicationId: "app", clientSecret: "s", botToken: "bot", publicKey: "k" }
      : null,
}));
vi.mock("@/lib/chat/bot", () => ({
  getChatBot: () => ({
    chat: {
      initialize: async () => {
        state.initialized += 1;
      },
    },
    adapters: {
      discord: {
        async startGatewayListener(
          options: { waitUntil: (task: Promise<unknown>) => void },
          durationMs?: number,
          abortSignal?: AbortSignal,
          webhookUrl?: string,
        ) {
          // Only listening once the bot is initialized (the adapter needs it).
          expect(state.initialized).toBe(1);
          options.waitUntil(Promise.resolve());
          state.listeners.push({ durationMs, abortSignal, webhookUrl });
          return Response.json({ status: "listening", durationMs });
        },
      },
    },
  }),
}));

process.env.CRON_SECRET = "cron-secret";
process.env.APP_URL = "https://omniralph.example.com/";
const route = await import("./discord-gateway/route");

const cron = (authorization?: string) =>
  route.GET(
    new Request("http://localhost/api/cron/discord-gateway", {
      headers: authorization ? { authorization } : {},
    }),
  );

beforeEach(() => {
  state.configured = true;
  state.initialized = 0;
  state.afterTasks = [];
  state.listeners = [];
});

describe("GET /api/cron/discord-gateway", () => {
  it("requires the cron secret", async () => {
    expect((await cron()).status).toBe(401);
    expect((await cron("Bearer wrong")).status).toBe(401);
    expect(state.listeners).toEqual([]);
  });

  it("skips when Discord isn't configured", async () => {
    state.configured = false;
    const res = await cron("Bearer cron-secret");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: "not_configured" });
    expect(state.listeners).toEqual([]);
  });

  it("listens for the configured duration, forwarding to the Discord webhook", async () => {
    const res = await cron("Bearer cron-secret");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "listening", durationMs: 600_000 });
    expect(state.listeners).toEqual([
      {
        durationMs: DISCORD_GATEWAY_LISTEN_SECONDS * 1000,
        abortSignal: undefined,
        webhookUrl: "https://omniralph.example.com/api/webhooks/discord",
      },
    ]);
    // The listener keeps running after the response.
    expect(state.afterTasks).toHaveLength(1);
  });
});

describe("Discord Gateway timing", () => {
  it("overlaps consecutive listeners within the function's duration", () => {
    expect(route.maxDuration).toBe(DISCORD_GATEWAY_MAX_DURATION_SECONDS);
    expect(DISCORD_GATEWAY_CRON_MINUTES * 60).toBeLessThan(DISCORD_GATEWAY_LISTEN_SECONDS);
    expect(DISCORD_GATEWAY_LISTEN_SECONDS).toBeLessThan(DISCORD_GATEWAY_MAX_DURATION_SECONDS);
    // Vercel's limit with Fluid compute.
    expect(DISCORD_GATEWAY_MAX_DURATION_SECONDS).toBeLessThanOrEqual(800);
  });

  it("is declared in vercel.json at the matching schedule", () => {
    const vercel = JSON.parse(
      readFileSync(new URL("../../../../vercel.json", import.meta.url), "utf8"),
    ) as {
      crons: Array<{ path: string; schedule: string }>;
    };
    expect(vercel.crons).toContainEqual({
      path: "/api/cron/discord-gateway",
      schedule: DISCORD_GATEWAY_CRON_SCHEDULE,
    });
  });
});
