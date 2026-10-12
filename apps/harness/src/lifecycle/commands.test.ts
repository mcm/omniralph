import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SetupCommand, TeardownCommand, TRUNCATION_MARKER } from "@omniralph/tasks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { silentLogger, type Logger } from "../logger.js";
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
    it("runs the command with sh -c in the working directory and the given environment", async () => {
      const outcome = await runCommand(
        'printf "%s|%s|%s" "$0" "$PWD" "${OMNIRALPH_JOB_TOKEN-unset}"',
        {
          cwd: dir,
          env: ENV,
          timeoutMs: 10_000,
          maxStdoutBytes: 1000,
        },
      );
      expect(outcome.stdout).toBe(`sh|${await realpath(dir)}|unset`);
    });

    it("caps stdout in bytes without splitting a character", async () => {
      const outcome = await runCommand("printf 'aé€'", {
        cwd: dir,
        env: ENV,
        timeoutMs: 10_000,
        maxStdoutBytes: 5,
      });
      // a (1 byte) + é (2) + the first 2 of € (3) → the partial € is dropped.
      expect(outcome).toMatchObject({ stdout: "aé", truncated: true });
    });

    it("keeps stdout and stderr apart and caps stdout", async () => {
      const outcome = await runCommand("printf 0123456789; echo oops >&2", {
        cwd: dir,
        env: ENV,
        timeoutMs: 10_000,
        maxStdoutBytes: 4,
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
        maxStdoutBytes: 100,
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
        maxStdoutBytes: 100,
        signal: controller.signal,
      });
      expect(outcome).toMatchObject({ timedOut: false, exitCode: null });
    });

    it("reports a command that can't start", async () => {
      const outcome = await runCommand("true", {
        cwd: path.join(dir, "missing"),
        env: ENV,
        timeoutMs: 1_000,
        maxStdoutBytes: 100,
      });
      expect(outcome.exitCode).toBeNull();
      expect(outcome.spawnError).toBeDefined();
    });
  });

  describe("runSetupCommands", () => {
    it("runs without either job token or the git credential helper configuration", async () => {
      const env = {
        ...ENV,
        OMNIRALPH_JOB_TOKEN: "lifecycle-token",
        OMNIRALPH_SESSION_TOKEN: "session-token",
        OMNIRALPH_SERVER: "https://omniralph.test",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: "omniralph-harness git-credential",
      };
      const result = await runSetupCommands(
        setup({ name: "env", command: "env | grep -E '^(OMNIRALPH_|GIT_CONFIG_)' || true" }),
        { ...options(), env, signal: new AbortController().signal },
      );
      expect(result).toEqual({ env: "" });
    });

    it("adds an installable command's cache directories after stripping OMNIRALPH_*", async () => {
      const bin = path.join(dir, "graph-index.sh");
      await writeFile(bin, "#!/bin/sh\nenv | grep '^OMNIRALPH_' | sort\n");
      await chmod(bin, 0o755);
      const result = await runSetupCommands(
        setup(
          { name: "graph", command: "graph-index --all" },
          { name: "plain", command: "env | grep '^OMNIRALPH_' || true" },
        ),
        {
          ...options(),
          env: { ...ENV, OMNIRALPH_JOB_TOKEN: "token", OMNIRALPH_CACHE_DIR: "/elsewhere" },
          executables: new Map([["graph-index", bin]]),
          executableEnv: new Map([
            [
              "graph-index",
              {
                OMNIRALPH_CACHE_DIR: "/data/cache/g/r",
                OMNIRALPH_PR_CACHE_DIR: "/data/pr-cache/g/r/4",
              },
            ],
          ]),
          signal: new AbortController().signal,
        },
      );
      expect(result).toEqual({
        graph: "OMNIRALPH_CACHE_DIR=/data/cache/g/r\nOMNIRALPH_PR_CACHE_DIR=/data/pr-cache/g/r/4\n",
        plain: "",
      });
    });

    it("returns each command's stdout by name, marking cut output", async () => {
      const result = await runSetupCommands(
        setup(
          { name: "a", command: "echo first > out.txt; echo one" },
          { name: "b", command: "cat out.txt; printf 'xxxxxx'", maxOutputBytes: 8 },
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

    it("throws SetupCommandError naming a required command that timed out", async () => {
      await expect(
        runSetupCommands(setup({ name: "slow", command: "sleep 30", timeoutSeconds: 0.1 }), {
          ...options(),
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("setup command slow failed: it timed out after 100ms");
    });

    it("puts a one-line failure note in an optional command's variable and runs the next one", async () => {
      const result = await runSetupCommands(
        setup(
          { name: "bad", command: "echo out; echo 'line 1\nline 2' >&2; exit 3", optional: true },
          { name: "slow", command: "sleep 30", timeoutSeconds: 0.1, optional: true },
          { name: "next", command: "echo next" },
        ),
        { ...options(), signal: new AbortController().signal },
      );
      expect(result).toEqual({
        bad: "(The setup command bad failed: it exited with code 3.)",
        slow: "(The setup command slow failed: it timed out after 100ms.)",
        next: "next\n",
      });
    });

    it("logs stderr instead of exposing it", async () => {
      const info = vi.fn();
      const logger = { info, warn: vi.fn() } as unknown as Logger;
      const result = await runSetupCommands(
        setup({ name: "a", command: "echo out; echo secret >&2" }),
        {
          ...options(),
          logger,
          signal: new AbortController().signal,
        },
      );
      expect(result).toEqual({ a: "out\n" });
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({ name: "a", stderr: "secret" }),
        "setup command finished",
      );
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
    it("runs without either job token or the git credential helper configuration", async () => {
      const env = { ...ENV, OMNIRALPH_JOB_TOKEN: "token", GIT_CONFIG_COUNT: "1" };
      await runTeardownCommands(
        [TeardownCommand.parse({ name: "env", command: "env > env.txt" })],
        { ...options(), env },
      );
      const written = await readFile(path.join(dir, "env.txt"), "utf8");
      expect(written).not.toContain("OMNIRALPH_");
      expect(written).not.toContain("GIT_CONFIG_");
      expect(written).toContain("PATH=");
    });

    it("adds an installable command's cache directories", async () => {
      await runTeardownCommands(
        [TeardownCommand.parse({ name: "save", command: "graph-save > env.txt" })],
        {
          ...options(),
          executables: new Map([["graph-save", "/usr/bin/env"]]),
          executableEnv: new Map([["graph-save", { OMNIRALPH_CACHE_DIR: "/data/cache/g/r" }]]),
        },
      );
      const written = await readFile(path.join(dir, "env.txt"), "utf8");
      expect(written).toContain("OMNIRALPH_CACHE_DIR=/data/cache/g/r\n");
    });

    it("runs every command, even after a failure", async () => {
      await runTeardownCommands(
        [
          { name: "fail", command: "exit 1" },
          { name: "slow", command: "sleep 30", timeoutSeconds: 0.1 },
          { name: "done", command: "echo done > done" },
        ].map((c) => TeardownCommand.parse(c)),
        options(),
      );
      expect(await readFile(path.join(dir, "done"), "utf8")).toBe("done\n");
    });
  });
});
