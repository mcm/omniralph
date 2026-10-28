import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "./config.js";
import { silentLogger } from "./logger.js";
import {
  LocalSettingsStore,
  SETTINGS_DEBOUNCE_MS,
  localSettingsPath,
  type LocalSettingsState,
  type SettingsClock,
} from "./settings.js";
import { memorySettingsFs } from "./test/settings-fs.js";

const FILE = "/data/settings.json";

function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A clock whose timers run only when `advance` passes their time. */
function manualClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: SettingsClock = {
    setTimeout: (callback, ms) => {
      const id = ++nextId;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout: (handle) => void timers.delete(handle as number),
  };
  return {
    clock,
    pending: () => timers.size,
    async advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.callback();
      }
      // Let the reload it queued finish.
      for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function setup() {
  const memory = memorySettingsFs();
  const time = manualClock();
  const logger = silentLogger();
  const errors = vi.spyOn(logger, "error");
  const open = async () => {
    const store = await LocalSettingsStore.open({
      file: FILE,
      logger,
      fs: memory.fs,
      clock: time.clock,
    });
    const changes: LocalSettingsState[] = [];
    store.on("change", (state) => changes.push(state));
    await store.watch();
    return { store, changes };
  };
  return { memory, time, errors, open };
}

describe("localSettingsPath", () => {
  it("is settings.json in the data directory", () => {
    expect(localSettingsPath("/home/h/.omniralph")).toBe("/home/h/.omniralph/settings.json");
  });
});

describe("LocalSettingsStore.read", () => {
  it("is every default with revision none when there is no file", async () => {
    const { open } = setup();
    const { store } = await open();
    expect(store.read()).toEqual({
      settings: { v: 1 },
      effective: {
        maxConcurrency: 5,
        poolLimits: { long: 4, short: 5 },
        acceptedTaskTypes: ["query", "review", "coding"],
        hostTools: {},
        installablesAllow: ["@omniralph/*"],
        versionPin: null,
      },
      revision: "none",
      lastError: null,
    });
  });

  it("returns the file's settings and the SHA-256 of its bytes", async () => {
    const { memory, open } = setup();
    const text = `{"v":1,  "maxConcurrency": 3, "acceptedTaskTypes": ["coding"]}`;
    memory.files.set(FILE, text);
    const { store } = await open();
    const state = store.read();
    expect(state.settings).toEqual({ v: 1, maxConcurrency: 3, acceptedTaskTypes: ["coding"] });
    expect(state.effective).toMatchObject({
      maxConcurrency: 3,
      poolLimits: { long: 2, short: 3 },
      acceptedTaskTypes: ["coding"],
    });
    expect(state.revision).toBe(sha256(text));
    // A copy: changing it changes nothing.
    state.settings.maxConcurrency = 9;
    expect(store.effective().maxConcurrency).toBe(3);
  });

  it.each([
    ["not JSON", "{", /isn't valid JSON/],
    ["an invalid value", `{"v":1,"maxConcurrency":33}`, /maxConcurrency/],
    ["an unknown key", `{"v":1,"server":"x"}`, /server/],
  ])("refuses to open %s", async (_name, text, message) => {
    const { memory, open } = setup();
    memory.files.set(FILE, text);
    const error = await open().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toMatch(message);
    expect((error as Error).message).toContain(FILE);
  });
});

describe("LocalSettingsStore.update", () => {
  it("writes the section, returns the new revision and emits change", async () => {
    const { memory, open } = setup();
    const { store, changes } = await open();
    const result = await store.update(
      "capacity",
      { maxConcurrency: 8, poolLimits: { long: null, short: 2 } },
      "none",
    );
    expect(result.status).toBe("saved");
    const text = memory.files.get(FILE)!;
    expect(JSON.parse(text)).toEqual({ v: 1, maxConcurrency: 8, poolLimits: { short: 2 } });
    expect(memory.modes.get(FILE)).toBe(0o600);
    const state = result.status === "saved" ? result.state : undefined;
    expect(state?.revision).toBe(sha256(text));
    expect(store.read().revision).toBe(sha256(text));
    expect(state?.effective.poolLimits).toEqual({ long: 7, short: 2 });
    expect(changes).toEqual([state]);
  });

  it("answers a conflict with the current settings for a stale revision, writing nothing", async () => {
    const { memory, open } = setup();
    const { store, changes } = await open();
    await store.update("kinds", { acceptedTaskTypes: ["review"] }, "none");
    const text = memory.files.get(FILE);
    const result = await store.update("allow-list", { allow: [] }, "none");
    expect(result).toEqual({ status: "conflict", state: store.read() });
    expect(result.status === "conflict" && result.state.settings).toEqual({
      v: 1,
      acceptedTaskTypes: ["review"],
    });
    expect(memory.files.get(FILE)).toBe(text);
    expect(changes).toHaveLength(1);
  });

  it("refuses a section that would make the settings invalid, writing nothing", async () => {
    const { memory, open } = setup();
    memory.files.set(FILE, `{"v":1,"poolLimits":{"long":4}}`);
    const { store, changes } = await open();
    const result = await store.update(
      "capacity",
      { maxConcurrency: 2, poolLimits: { long: 4, short: null } },
      store.read().revision,
    );
    expect(result).toEqual({
      status: "invalid",
      issues: [{ path: ["poolLimits", "long"], message: "must be at most maxConcurrency (2)" }],
    });
    expect(memory.files.get(FILE)).toBe(`{"v":1,"poolLimits":{"long":4}}`);
    expect(changes).toEqual([]);
  });

  it("doesn't apply its own write a second time when the watcher sees it", async () => {
    const { time, open } = setup();
    const { store, changes } = await open();
    await store.update("version", { pin: "2.0.3" }, "none");
    await time.advance(SETTINGS_DEBOUNCE_MS);
    expect(changes).toHaveLength(1);
    expect(store.read().effective.versionPin).toBe("2.0.3");
  });
});

describe("LocalSettingsStore hand edits", () => {
  it("applies a valid hand edit once the file has been quiet for 250 ms", async () => {
    const { memory, time, open } = setup();
    const { store, changes } = await open();
    memory.handEdit(FILE, `{"v":1,"maxConcurrency":2}`);
    await time.advance(SETTINGS_DEBOUNCE_MS - 50);
    memory.handEdit(FILE, `{"v":1,"maxConcurrency":3}`);
    await time.advance(SETTINGS_DEBOUNCE_MS - 1);
    expect(changes).toEqual([]);
    expect(store.effective().maxConcurrency).toBe(5);
    await time.advance(1);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.settings).toEqual({ v: 1, maxConcurrency: 3 });
    expect(changes[0]!.revision).toBe(sha256(`{"v":1,"maxConcurrency":3}`));
    expect(store.effective().maxConcurrency).toBe(3);
  });

  it("ignores other files in the directory", async () => {
    const { memory, time, open } = setup();
    await open();
    memory.handEdit("/data/agent.log", "x");
    expect(time.pending()).toBe(0);
  });

  it("keeps the last good settings on an invalid hand edit, logs it and exposes it until fixed", async () => {
    const { memory, time, errors, open } = setup();
    memory.files.set(FILE, `{"v":1,"maxConcurrency":3}`);
    const { store, changes } = await open();
    const good = store.read();

    memory.handEdit(FILE, `{"v":1,"maxConcurrency":40}`);
    await time.advance(SETTINGS_DEBOUNCE_MS);
    expect(store.read()).toEqual({ ...good, lastError: expect.stringMatching(/^maxConcurrency/) });
    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({ file: FILE }),
      expect.stringMatching(
        /^settings\.json isn't valid: maxConcurrency.*; the agent keeps its last good settings$/,
      ),
    );
    expect(changes.at(-1)!.lastError).toMatch(/^maxConcurrency/);

    // The same bad file again: nothing new.
    memory.handEdit(FILE, `{"v":1,"maxConcurrency":40}`);
    await time.advance(SETTINGS_DEBOUNCE_MS);
    expect(errors).toHaveBeenCalledTimes(1);

    memory.handEdit(FILE, "{ not json");
    await time.advance(SETTINGS_DEBOUNCE_MS);
    expect(store.read().lastError).toBe("it isn't valid JSON");
    expect(store.effective().maxConcurrency).toBe(3);

    memory.handEdit(FILE, `{"v":1,"maxConcurrency":4}`);
    await time.advance(SETTINGS_DEBOUNCE_MS);
    expect(store.read().lastError).toBeNull();
    expect(store.effective().maxConcurrency).toBe(4);
    expect(changes.at(-1)!.settings).toEqual({ v: 1, maxConcurrency: 4 });
  });

  it("clears the error when the last good file is put back", async () => {
    const { memory, time, open } = setup();
    const text = `{"v":1,"maxConcurrency":3}`;
    memory.files.set(FILE, text);
    const { store, changes } = await open();
    memory.handEdit(FILE, `{"v":1,"bogus":true}`);
    await time.advance(SETTINGS_DEBOUNCE_MS);
    expect(store.read().lastError).toMatch(/bogus/);
    memory.handEdit(FILE, text);
    await time.advance(SETTINGS_DEBOUNCE_MS);
    expect(store.read().lastError).toBeNull();
    expect(changes.at(-1)!.lastError).toBeNull();
  });

  it("goes back to the defaults when the file is deleted", async () => {
    const { memory, time, open } = setup();
    memory.files.set(FILE, `{"v":1,"maxConcurrency":3}`);
    const { store, changes } = await open();
    memory.handEdit(FILE, null);
    await time.advance(SETTINGS_DEBOUNCE_MS);
    expect(store.read()).toMatchObject({ settings: { v: 1 }, revision: "none" });
    expect(changes).toHaveLength(1);
  });

  it("answers a conflict for a write while a valid hand edit is pending, keeping the edit", async () => {
    const { memory, time, open } = setup();
    const { store, changes } = await open();
    const before = store.read().revision;
    memory.handEdit(FILE, `{"v":1,"acceptedTaskTypes":["coding"]}`);

    const result = await store.update("kinds", { acceptedTaskTypes: ["review"] }, before);

    expect(result.status).toBe("conflict");
    expect(result.status === "conflict" && result.state.settings).toEqual({
      v: 1,
      acceptedTaskTypes: ["coding"],
    });
    expect(memory.files.get(FILE)).toBe(`{"v":1,"acceptedTaskTypes":["coding"]}`);
    // The edit was applied (once) by the write, not again by the debounce.
    expect(changes).toHaveLength(1);
    await time.advance(SETTINGS_DEBOUNCE_MS);
    expect(changes).toHaveLength(1);

    // Saving against the revision it answered works.
    const retry = await store.update(
      "kinds",
      { acceptedTaskTypes: ["review"] },
      result.status === "conflict" ? result.state.revision : "",
    );
    expect(retry.status).toBe("saved");
    expect(store.effective().acceptedTaskTypes).toEqual(["review"]);
  });

  it("saves over a pending invalid hand edit, which clears the error", async () => {
    const { memory, open } = setup();
    const { store } = await open();
    memory.handEdit(FILE, `{"v":1,"maxConcurrency":0}`);
    const result = await store.update("version", { pin: "2.0.4" }, "none");
    expect(result.status).toBe("saved");
    expect(JSON.parse(memory.files.get(FILE)!)).toEqual({ v: 1, update: { pin: "2.0.4" } });
    expect(store.read().lastError).toBeNull();
  });

  it("stops watching when closed", async () => {
    const { memory, time, open } = setup();
    const { store } = await open();
    expect(memory.watching()).toBe(1);
    await store.close();
    expect(memory.watching()).toBe(0);
    memory.handEdit(FILE, `{"v":1,"maxConcurrency":2}`);
    await time.advance(SETTINGS_DEBOUNCE_MS);
    expect(store.effective().maxConcurrency).toBe(5);
  });
});

describe("LocalSettingsStore on disk", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "omniralph-settings-"));
    file = path.join(dir, "data", "settings.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes atomically with mode 0600", async () => {
    const store = await LocalSettingsStore.open({ file, logger: silentLogger() });
    const result = await store.update("allow-list", { allow: ["@acme/*"] }, "none");
    const bytes = await readFile(file);
    expect(result.status === "saved" && result.state.revision).toBe(sha256(bytes));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(path.dirname(file))).toEqual(["settings.json"]);
    await store.close();
  });

  it("applies a hand edit seen by fs.watch", async () => {
    const store = await LocalSettingsStore.open({ file, logger: silentLogger() });
    await store.watch();
    const changed = new Promise<LocalSettingsState>((resolve) => store.once("change", resolve));
    await writeFile(file, JSON.stringify({ v: 1, maxConcurrency: 7 }), { mode: 0o600 });
    const state = await changed;
    expect(state.effective.maxConcurrency).toBe(7);
    expect(state.revision).toBe(sha256(await readFile(file)));
    await store.close();
  });
});
