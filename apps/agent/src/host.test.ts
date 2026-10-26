import { describe, expect, it } from "vitest";
import { agentHost } from "./host.js";

/** An environment that records every variable read from it. */
function recordingEnv(values: Record<string, string>) {
  const reads = new Set<string | symbol>();
  const env = new Proxy(
    { ...values, HOME: "/home/agent", OMNIRALPH_TOKEN: "secret", CODER_AGENT_TOKEN: "secret" },
    {
      get(target, key) {
        reads.add(key);
        return Reflect.get(target, key);
      },
    },
  ) as NodeJS.ProcessEnv;
  return { env, reads };
}

describe("agentHost", () => {
  it("reports the Coder workspace when both its variables are set", () => {
    const { env, reads } = recordingEnv({
      CODER_WORKSPACE_OWNER_NAME: "steve",
      CODER_WORKSPACE_NAME: "omniralph",
    });
    const host = agentHost(env, () => "coder-ws-1");
    expect(host).toEqual({
      hostname: "coder-ws-1",
      coder: { owner: "steve", workspace: "omniralph" },
    });
    expect(Object.keys(host).sort()).toEqual(["coder", "hostname"]);
    expect(Object.keys(host.coder!).sort()).toEqual(["owner", "workspace"]);
    expect([...reads].sort()).toEqual(["CODER_WORKSPACE_NAME", "CODER_WORKSPACE_OWNER_NAME"]);
  });

  it("reports no Coder workspace on a plain machine", () => {
    const { env, reads } = recordingEnv({});
    const host = agentHost(env, () => "build-01");
    expect(host).toEqual({ hostname: "build-01", coder: null });
    expect(Object.keys(host).sort()).toEqual(["coder", "hostname"]);
    expect([...reads].sort()).toEqual(["CODER_WORKSPACE_NAME", "CODER_WORKSPACE_OWNER_NAME"]);
  });

  it("reports no Coder workspace when only one of its variables is set", () => {
    expect(agentHost({ CODER_WORKSPACE_NAME: "omniralph" }, () => "h").coder).toBeNull();
    expect(agentHost({ CODER_WORKSPACE_OWNER_NAME: "steve" }, () => "h").coder).toBeNull();
    expect(
      agentHost({ CODER_WORKSPACE_OWNER_NAME: " ", CODER_WORKSPACE_NAME: "omniralph" }, () => "h")
        .coder,
    ).toBeNull();
  });

  it("caps the host name at 255 characters", () => {
    expect(agentHost({}, () => "x".repeat(300)).hostname).toHaveLength(255);
  });

  it("reads the host name from the OS by default", () => {
    expect(agentHost({}).hostname.length).toBeGreaterThan(0);
  });
});
