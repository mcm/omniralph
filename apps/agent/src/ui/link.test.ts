import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  openerCommand,
  processAlive,
  readUiLink,
  removeUiLink,
  uiLinkPath,
  uiPageUrl,
  writeUiLink,
  type UiLink,
} from "./link.js";

const LINK: UiLink = {
  pid: process.pid,
  port: 7410,
  url: "http://127.0.0.1:7410",
  startedAt: "2026-10-28T10:42:00.000Z",
  token: "abc_-123",
};

describe("ui.json", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "omniralph-ui-link-"));
    file = uiLinkPath(path.join(dir, "agent.json"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lives next to agent.json, readable by its owner only", async () => {
    expect(file).toBe(path.join(dir, "ui.json"));
    await writeUiLink(file, LINK);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(LINK);
    expect(await readUiLink(file)).toEqual(LINK);
  });

  it("reads as none when missing or not valid", async () => {
    expect(await readUiLink(file)).toBeNull();
    await writeUiLink(file, { ...LINK, port: "nope" } as unknown as UiLink);
    expect(await readUiLink(file)).toBeNull();
  });

  it("is removed only by the process that wrote it", async () => {
    await writeUiLink(file, LINK);
    await removeUiLink(file, process.pid + 1);
    expect(await readUiLink(file)).toEqual(LINK);
    await removeUiLink(file, process.pid);
    expect(await readUiLink(file)).toBeNull();
    // Already gone: nothing to do.
    await removeUiLink(file, process.pid);
  });

  it("builds the page link with the token", () => {
    expect(uiPageUrl(LINK)).toBe("http://127.0.0.1:7410/?token=abc_-123");
  });

  it("knows whether a process runs", () => {
    expect(processAlive(process.pid)).toBe(true);
    // Above any Linux pid_max.
    expect(processAlive(2 ** 30)).toBe(false);
  });
});

describe("openerCommand", () => {
  const url = "http://127.0.0.1:7410/?token=abc";

  it.each([
    ["linux", { command: "xdg-open", args: [url] }],
    ["freebsd", { command: "xdg-open", args: [url] }],
    ["darwin", { command: "open", args: [url] }],
    ["win32", { command: "cmd", args: ["/c", "start", "", url] }],
  ] as const)("opens the default browser on %s", (platform, expected) => {
    expect(openerCommand(platform, url)).toEqual(expected);
  });
});
