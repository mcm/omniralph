import { describe, expect, it } from "vitest";
import {
  credentialConfigArgs,
  defaultCredentialHelper,
  gitEnv,
  runGit,
  shellQuote,
} from "./git.js";

describe("git helpers", () => {
  it("resets host credential helpers before configuring the agent's", () => {
    expect(credentialConfigArgs("!helper")).toEqual([
      "-c",
      "credential.helper=",
      "-c",
      "credential.helper=!helper",
      "-c",
      "core.askPass=",
    ]);
  });

  it("drops host askpass programs and disables prompts", () => {
    expect(
      gitEnv({
        PATH: "/bin",
        GIT_ASKPASS: "/tmp/coder",
        SSH_ASKPASS: "/x",
        OMNIRALPH_JOB_TOKEN: "t",
      }),
    ).toEqual({ PATH: "/bin", OMNIRALPH_JOB_TOKEN: "t", GIT_TERMINAL_PROMPT: "0" });
  });

  it("builds a shell-quoted helper command for this CLI", () => {
    expect(shellQuote("/usr/bin/node")).toBe("/usr/bin/node");
    expect(shellQuote("it's here")).toBe(`'it'\\''s here'`);
    expect(
      defaultCredentialHelper(
        "/opt/node 22/bin/node",
        ["--import", "tsx"],
        "/srv/agent/dist/cli.js",
      ),
    ).toBe("!'/opt/node 22/bin/node' --import tsx /srv/agent/dist/cli.js git-credential");
  });

  it("rejects with the abort reason when aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(
      runGit(["--version"], { env: process.env, signal: controller.signal }),
    ).rejects.toThrow("stop");
    await expect(runGit(["--version"], { env: process.env })).resolves.toMatch(/^git version/);
    await expect(runGit(["no-such-command"], { env: process.env })).rejects.toThrow(
      /failed \(exit 1\)/,
    );
  });
});
