import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  attachmentsDir,
  collectAttachments,
  controlPanelFetcher,
  type AttachmentFetcher,
} from "../../tools/attachments.js";

const id = (n: number) => n.toString(16).padStart(32, "0");

describe("collectAttachments", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "omniralph-att-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("dedupes names, caches by attachment ID, and caps downloads per call", async () => {
    const calls: string[] = [];
    const fetcher: AttachmentFetcher = async (attachmentId) => {
      calls.push(attachmentId);
      return { ok: true, contentType: "image/png", data: Buffer.from(attachmentId) };
    };
    const attachments = [
      { id: id(1), title: "shot.png", sources: ["desc"] },
      { id: id(2), title: "shot.png", sources: ["desc"] },
      { id: id(3), title: "x", sources: ["desc"] },
    ];
    const first = await collectAttachments({ attachments, dir, fetcher, max: 2 });
    expect(first.files.map((e) => e.path?.split("/").pop() ?? e.error)).toEqual([
      "shot.png",
      "shot-2.png",
      "skipped: more than 2 attachments",
    ]);
    expect(first.failureNote).toContain("I couldn't download 1 of 3 attachment(s)");
    const second = await collectAttachments({ attachments, dir, fetcher, max: 2 });
    expect(second.files.every((e) => e.path)).toBe(true);
    expect(second.failureNote).toBeUndefined();
    expect(calls).toEqual([id(1), id(2), id(3)]);
    expect((await readdir(dir)).sort()).toEqual([".index.json", "shot-2.png", "shot.png", "x.png"]);
  });

  it("names untitled files attachment-N with an extension from the content type", async () => {
    const fetcher: AttachmentFetcher = async () => ({
      ok: true,
      contentType: "application/pdf",
      data: Buffer.from("%PDF"),
    });
    const { files, prompt } = await collectAttachments({
      attachments: [
        { id: id(1), title: null, sources: ["ENG-2"] },
        { id: id(2), title: null, sources: ["ENG-2"] },
      ],
      dir,
      fetcher,
    });
    expect(files.map((f) => path.basename(f.path!))).toEqual([
      "attachment-1.pdf",
      "attachment-2.pdf",
    ]);
    expect(prompt).toBe(
      `- attachment (from ENG-2): \`${path.join(dir, "attachment-1.pdf")}\`\n- attachment (from ENG-2): \`${path.join(dir, "attachment-2.pdf")}\``,
    );
  });

  it("does nothing without attachments", async () => {
    const empty = path.join(dir, "none");
    const collected = await collectAttachments({
      attachments: [],
      dir: empty,
      fetcher: async () => {
        throw new Error("no download expected");
      },
    });
    expect(collected).toEqual({ dir: empty, files: [] });
  });

  it("keeps each epic's files in its own folder under the workspace root", () => {
    expect(attachmentsDir("/w", "TOOL-32")).toBe("/w/.attachments/TOOL-32");
    expect(attachmentsDir("/w", "../x")).toBe("/w/.attachments/___x");
  });
});

describe("controlPanelFetcher", () => {
  it("downloads through the job's attachment endpoint with the job token, and reports failures", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    let token = "tok-1";
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (url.endsWith(id(1))) {
        return new Response("PNGDATA", { headers: { "content-type": "image/png" } });
      }
      if (url.endsWith(id(2))) {
        return Response.json({ error: "download_failed", reason: "HTTP 401" }, { status: 502 });
      }
      if (url.endsWith(id(3))) {
        return new Response("<html>", { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return Response.json({ error: "scope_mismatch" }, { status: 403 });
    }) as typeof fetch;
    const fetcher = controlPanelFetcher({
      server: "https://cp.example.com",
      jobId: "job-1",
      jobToken: () => token,
      fetch: fetchFn,
    });

    const ok = await fetcher(id(1));
    expect(ok).toMatchObject({ ok: true, contentType: "image/png" });
    expect(ok.data?.toString()).toBe("PNGDATA");
    token = "tok-2"; // a refreshed job token is picked up
    expect(await fetcher(id(2))).toMatchObject({ ok: false, error: "HTTP 401" });
    expect(await fetcher(id(3))).toMatchObject({
      ok: false,
      error: "got an HTML page instead of the file",
    });
    expect(await fetcher(id(4))).toMatchObject({ ok: false, error: "HTTP 403 (scope_mismatch)" });
    expect(seen.map((s) => s.auth)).toEqual([
      "Bearer tok-1",
      "Bearer tok-2",
      "Bearer tok-2",
      "Bearer tok-2",
    ]);
    expect(seen[0]?.url).toBe(`https://cp.example.com/api/agent/jobs/job-1/attachments/${id(1)}`);
  });

  it("rejects files over 25 MB", async () => {
    const big = new Uint8Array(25 * 1024 * 1024 + 1);
    const fetcher = controlPanelFetcher({
      server: "https://cp.example.com",
      jobId: "job-1",
      jobToken: () => "t",
      fetch: (async () =>
        new Response(big, { headers: { "content-type": "image/png" } })) as typeof fetch,
    });
    expect(await fetcher(id(1))).toMatchObject({ ok: false, error: "larger than 25 MB" });
  });
});
