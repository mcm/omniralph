import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SetupCommand, TeardownCommand, TRUNCATION_MARKER } from "@omniralph/tasks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { silentLogger } from "../logger.js";
import {
  runCommand,
  runSetupCommands,
  runTeardownCommands,
  SetupCommandError,
} from "./commands.js";

const ENV = { PATH: process.env.PATH, HOME: process.env.HOME };

describe("lifecycle commands", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "omniralph-commands-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const options = () => ({ cwd: dir, env: ENV, logger: silentLogger() });
  const setup = (...commands: Parameters<typeof SetupCommand.parse>[0][]) =>
    commands.map((command) => SetupCommand.parse(command));

  describe("runCommand", () => {
    it("keeps stdout and stderr apart and caps stdout", async () => {
      const outcome = await runCommand("printf 0123456789; echo oops >&2", {
        cwd: dir,
        env: ENV,
        timeoutMs: 10_000,
        maxStdout: 4,
      });
      expect(outcome).toEqual({
        exitCode: 0,
        stdout: "0123",
        truncated: true,
        stderr: "oops",
        timedOut: false,
      });
    });

    it("kills the command's whole process group on timeout", async () => {
      const marker = path.join(dir, "late");
      const started = Date.now();
      const outcome = await runCommand(`(sleep 1; touch '${marker}') & sleep 30`, {
        cwd: dir,
        env: ENV,
        timeoutMs: 200,
        maxStdout: 100,
      });
      expect(outcome).toMatchObject({ timedOut: true, exitCode: null });
      expect(Date.now() - started).toBeLessThan(5_000);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await expect(readFile(marker)).rejects.toThrow();
    });

    it("stops when the signal aborts", async () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error("canceled")), 100);
      const outcome = await runCommand("sleep 30", {
        cwd: dir,
        env: ENV,
        timeoutMs: 60_000,
        maxStdout: 100,
        signal: controller.signal,
      });
      expect(outcome).toMatchObject({ timedOut: false, exitCode: null });
    });

    it("reports a command that can't start", async () => {
      const outcome = await runCommand("true", {
        cwd: path.join(dir, "missing"),
        env: ENV,
        timeoutMs: 1_000,
        maxStdout: 100,
      });
      expect(outcome.exitCode).toBeNull();
      expect(outcome.spawnError).toBeDefined();
    });
  });

  describe("runSetupCommands", () => {
    it("returns each command's stdout by name, marking cut output", async () => {
      const result = await runSetupCommands(
        setup(
          { name: "a", command: "echo first > out.txt; echo one" },
          { name: "b", command: "cat out.txt; printf 'xxxxxx'", maxOutputChars: 8 },
        ),
        { ...options(), signal: new AbortController().signal },
      );
      expect(result).toEqual({ a: "one\n", b: `first\nxx${TRUNCATION_MARKER}` });
    });

    it("throws SetupCommandError on a failing required command and stops there", async () => {
      const result = runSetupCommands(
        setup({ name: "bad", command: "exit 2" }, { name: "never", command: "touch never" }),
        { ...options(), signal: new AbortController().signal },
      );
      await expect(result).rejects.toBeInstanceOf(SetupCommandError);
      await expect(result).rejects.toThrow("setup command bad failed: it exited with code 2");
      await expect(readFile(path.join(dir, "never"))).rejects.toThrow();
    });

    it("throws the abort reason when the run is aborted", async () => {
      const controller = new AbortController();
      const reason = new Error("canceled");
      setTimeout(() => controller.abort(reason), 100);
      await expect(
        runSetupCommands(setup({ name: "slow", command: "sleep 30", optional: true }), {
          ...options(),
          signal: controller.signal,
        }),
      ).rejects.toBe(reason);
    });
  });

  describe("runTeardownCommands", () => {
    it("runs every command, even after a failure", async () => {
      await runTeardownCommands(
        [{ command: "exit 1" }, { command: "echo done > done" }].map((c) =>
          TeardownCommand.parse(c),
        ),
        options(),
      );
      expect(await readFile(path.join(dir, "done"), "utf8")).toBe("done\n");
    });
  });
});
