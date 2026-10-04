import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { JOB_TOKEN_ENV, jobProcessEnv, spawnJobProcess } from "./job-env.js";

const JOB = { jobId: randomUUID(), jobToken: "job-token-123", server: "https://omniralph.example" };

function childEnv(child: ReturnType<typeof spawnJobProcess>): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("error", reject);
    child.on("close", () => resolve(JSON.parse(out) as Record<string, string>));
  });
}

describe("job subprocess environment", () => {
  it("adds the job token, job ID and server and strips every OMNIRALPH_* variable", () => {
    const env = jobProcessEnv(JOB, {
      PATH: "/usr/bin",
      HOME: "/home/agent",
      OMNIRALPH_REFRESH_TOKEN: "refresh-secret",
      OMNIRALPH_ACCESS_TOKEN: "access-secret",
      OMNIRALPH_AGENT_CONFIG: "/home/agent/.config/omniralph/agent.json",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/agent",
      OMNIRALPH_JOB_TOKEN: "job-token-123",
      OMNIRALPH_JOB_ID: JOB.jobId,
      OMNIRALPH_SERVER: "https://omniralph.example",
    });
  });

  it("doesn't let extra variables override the job token", () => {
    const env = jobProcessEnv(JOB, {}, { [JOB_TOKEN_ENV]: "forged", GIT_TERMINAL_PROMPT: "0" });
    expect(env[JOB_TOKEN_ENV]).toBe("job-token-123");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("spawns processes that see only the job token", async () => {
    process.env.OMNIRALPH_TEST_SECRET = "agent-secret";
    try {
      const child = spawnJobProcess(
        JOB,
        process.execPath,
        ["-e", "process.stdout.write(JSON.stringify(process.env))"],
        { stdio: ["ignore", "pipe", "inherit"], env: { EXTRA: "1" } },
      );
      const env = await childEnv(child);
      expect(env.OMNIRALPH_JOB_TOKEN).toBe("job-token-123");
      expect(env.OMNIRALPH_JOB_ID).toBe(JOB.jobId);
      expect(env.EXTRA).toBe("1");
      expect(env.OMNIRALPH_TEST_SECRET).toBeUndefined();
      expect(JSON.stringify(env)).not.toContain("agent-secret");
    } finally {
      delete process.env.OMNIRALPH_TEST_SECRET;
    }
  });
});
