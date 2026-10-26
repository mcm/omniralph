import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { AblyRestWakePublisher, getWakePublisher } from "./publisher";

const CONFIG = { keyName: "appId.keyId", keySecret: "s3cr3t" };

describe("AblyRestWakePublisher", () => {
  it("posts an empty wake message to the channel with the API key", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 201 }));
    await new AblyRestWakePublisher(CONFIG, { fetch }).wake("agent:abc");

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://rest.ably.io/channels/agent%3Aabc/messages");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ name: "wake" });
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from("appId.keyId:s3cr3t").toString("base64")}`,
    );
  });

  it("throws when Ably answers with an error", async () => {
    const fetch = vi.fn(async () => new Response('{"error":{}}', { status: 401 }));
    await expect(new AblyRestWakePublisher(CONFIG, { fetch }).wake("org:abc")).rejects.toThrow(
      /org:abc failed: 401/,
    );
  });
});

describe("getWakePublisher", () => {
  it("creates no publisher when ABLY_API_KEY is unset", () => {
    expect(getWakePublisher({})).toBeNull();
  });

  it("creates an Ably REST publisher when ABLY_API_KEY is set", () => {
    expect(getWakePublisher({ ABLY_API_KEY: "a.b:c" })).toBeInstanceOf(AblyRestWakePublisher);
  });
});
