import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAX_ATTACHMENT_BYTES, type RunAttachment } from "@omniralph/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { downloadRunAttachments, RunAttachmentDownloadError } from "./run-attachments.js";

const NOW = new Date("2026-11-05T10:00:00.000Z");

function attachment(overrides: Partial<RunAttachment> = {}): RunAttachment {
  const id = overrides.id ?? randomUUID();
  return {
    id,
    owner: "epic",
    ownerName: "ENG-10",
    fileName: "flow.png",
    contentType: "image/png",
    size: 4,
    url: `https://blob.test/attachments/org/${id}`,
    expiresAt: new Date(NOW.getTime() + 600_000).toISOString(),
    ...overrides,
  };
}

/** A file store serving `files` by URL; anything else is a 404. */
function store(files: Record<string, string>) {
  const fetched: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    fetched.push(String(input));
    const body = files[String(input)];
    return body === undefined ? new Response("missing", { status: 404 }) : new Response(body);
  }) as typeof fetch;
  return { fetch: fetchFn, fetched };
}

describe("downloadRunAttachments", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "run-attachments-test-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const download = (attachments: RunAttachment[], fetchFn: typeof fetch) =>
    downloadRunAttachments({ attachments, fetch: fetchFn, tmpDir: tmp, now: () => NOW });

  it("creates nothing without attachments", async () => {
    const { fetch, fetched } = store({});
    const downloaded = await download([], fetch);
    expect(downloaded).toMatchObject({ dir: null, files: [] });
    expect(downloaded.prompt).toBeUndefined();
    expect(fetched).toEqual([]);
    expect(await readdir(tmp)).toEqual([]);
  });

  it("saves the feature's and the epic's files in folders of their own, names deduplicated", async () => {
    const board = attachment({ owner: "feature", ownerName: "Exports", fileName: "board.png" });
    const first = attachment({ fileName: "board.png" });
    const second = attachment({ fileName: "board.png" });
    const unnamed = attachment({ fileName: "...", contentType: "application/pdf" });
    const { fetch } = store({
      [board.url]: "feature board",
      [first.url]: "first",
      [second.url]: "second",
      [unnamed.url]: "%PDF",
    });
    const downloaded = await download([board, first, second, unnamed], fetch);
    const dir = downloaded.dir!;
    expect(path.dirname(dir)).toBe(tmp);
    expect(downloaded.files.map((f) => path.relative(dir, f.path))).toEqual([
      path.join("feature", "board.png"),
      path.join("epic", "board.png"),
      path.join("epic", "board-2.png"),
      path.join("epic", "attachment-4.pdf"),
    ]);
    expect(await readFile(path.join(dir, "feature", "board.png"), "utf8")).toBe("feature board");
    expect(await readFile(path.join(dir, "epic", "board-2.png"), "utf8")).toBe("second");
    expect(downloaded.prompt).toContain(
      `- \`${path.join(dir, "feature", "board.png")}\`: board.png (image/png), attached to the feature "Exports"`,
    );

    await downloaded.remove();
    expect(await readdir(tmp)).toEqual([]);
  });

  it("keeps a file name's slashes and dots from leaving its folder", async () => {
    const sneaky = attachment({ fileName: "../../etc/`passwd`.png" });
    const { fetch } = store({ [sneaky.url]: "x" });
    const downloaded = await download([sneaky], fetch);
    const [file] = downloaded.files;
    expect(path.dirname(file!.path)).toBe(path.join(downloaded.dir!, "epic"));
    expect(path.basename(file!.path)).not.toContain("`");
  });

  it.each([
    ["an HTTP error", { status: 403 }, "the file store answered HTTP 403"],
    ["an expired link", { expired: true }, "its download link expired before the run started"],
    ["a network error", { throws: true }, "connection reset"],
    [
      "a file over the limit",
      { large: true },
      `it is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`,
    ],
  ])("fails on %s, naming the file and why, and leaves nothing behind", async (_, how, reason) => {
    const ok = attachment({ fileName: "ok.png" });
    const bad = attachment({
      owner: "feature",
      ownerName: "Exports",
      fileName: "board.pdf",
      ...("expired" in how && { expiresAt: new Date(NOW.getTime() - 1).toISOString() }),
    });
    const fetchFn = (async (input: string | URL | Request) => {
      if (String(input) === ok.url) return new Response("ok");
      if ("throws" in how) throw new TypeError("connection reset");
      if ("large" in how) return new Response(new Uint8Array(MAX_ATTACHMENT_BYTES + 1));
      return new Response("denied", { status: "status" in how ? how.status : 500 });
    }) as typeof fetch;

    const failed = download([ok, bad], fetchFn);
    await expect(failed).rejects.toThrow(RunAttachmentDownloadError);
    await expect(failed).rejects.toThrow(
      `Couldn't download the attachment "board.pdf" (attached to the feature "Exports"): ${reason}`,
    );
    expect(await readdir(tmp)).toEqual([]);
  });
});
