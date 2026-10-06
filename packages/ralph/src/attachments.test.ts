import { describe, expect, it } from "vitest";
import {
  attachmentFileName,
  attachmentsForStory,
  extractUploads,
  failedAttachmentsNote,
  formatAttachments,
  gatherAttachments,
  isUploadUrl,
  uniqueFileName,
} from "./attachments.js";

const U = "https://uploads.linear.app/org/a1b2/c3d4";

describe("extractUploads", () => {
  it("reads Linear's <linear-image> blocks (signed src + title), markdown and bare URLs", () => {
    const text = `<linear-image>{"type":"image","attrs":{"src":"${U}?signature=e.y.J","title":"pavilion_contact_sheet.png"}}</linear-image>
See ![mockup](${U}/m?signature=abc) and [spec.pdf](${U}/spec) and ${U}/bare.
Again: ${U}?signature=other`;
    expect(extractUploads(text)).toEqual([
      { url: U, title: "pavilion_contact_sheet.png" },
      { url: `${U}/m`, title: "mockup" },
      { url: `${U}/spec`, title: "spec.pdf" },
      { url: `${U}/bare` },
    ]);
    expect(extractUploads("no uploads here https://example.com/x.png")).toEqual([]);
    expect(extractUploads(undefined)).toEqual([]);
  });
});

describe("isUploadUrl", () => {
  it("accepts only unsigned Linear upload URLs", () => {
    expect(isUploadUrl(U)).toBe(true);
    expect(isUploadUrl(`${U}?signature=x`)).toBe(false);
    expect(isUploadUrl(`https://evil.example/?u=${U}`)).toBe(false);
    expect(isUploadUrl("https://uploads.linear.app.evil.example/x")).toBe(false);
  });
});

describe("attachmentFileName", () => {
  it("keeps titled names, adds an extension from the content type, and sanitises", () => {
    expect(attachmentFileName({ title: "pavilion_contact_sheet.png" }, "image/png", "a")).toBe(
      "pavilion_contact_sheet.png",
    );
    expect(attachmentFileName({ title: "badge mockup" }, "image/jpeg", "a")).toBe(
      "badge mockup.jpg",
    );
    expect(attachmentFileName({}, "image/webp", "attachment-3")).toBe("attachment-3.webp");
    expect(attachmentFileName({ title: "../../etc/passwd" }, "text/plain", "a")).toBe(
      "_.._etc_passwd.txt",
    );
    expect(attachmentFileName({ title: null }, "application/x-unknown", "f")).toBe("f.bin");
  });

  it("suffixes a name that is taken", () => {
    expect(uniqueFileName("shot.png", new Set())).toBe("shot.png");
    expect(uniqueFileName("shot.png", new Set(["shot.png", "shot-2.png"]))).toBe("shot-3.png");
  });
});

describe("gatherAttachments", () => {
  it("dedupes by URL, collects every source and scopes story uploads to their story", () => {
    const gathered = gatherAttachments([
      { label: "ENG-1 description", text: `![architecture.png](${U}/arch)` },
      { label: "ENG-3", text: `![badge mockup](${U}/badge?signature=x)`, storyKey: "s3" },
      { label: "comment on ENG-3 by Ana", text: `${U}/badge again`, storyKey: "s3" },
      { label: "Linear thread", text: `see ${U}/arch` },
    ]);
    expect(gathered).toEqual([
      {
        url: `${U}/arch`,
        title: "architecture.png",
        sources: ["ENG-1 description", "Linear thread"],
        storyKeys: [],
        shared: true,
      },
      {
        url: `${U}/badge`,
        title: "badge mockup",
        sources: ["ENG-3", "comment on ENG-3 by Ana"],
        storyKeys: ["s3"],
        shared: false,
      },
    ]);
    expect(attachmentsForStory(gathered, "s3").map((a) => a.title)).toEqual([
      "architecture.png",
      "badge mockup",
    ]);
    expect(attachmentsForStory(gathered, "s2").map((a) => a.title)).toEqual(["architecture.png"]);
  });
});

describe("formatAttachments", () => {
  it("lists downloaded files and says which ones couldn't be downloaded", () => {
    const files = [
      { title: "shot.png", sources: ["ENG-1 description"], path: "/w/.attachments/ENG-1/shot.png" },
      { title: null, sources: ["Linear thread", "ENG-2"], error: "HTTP 401" },
    ];
    expect(formatAttachments(files)).toBe(
      "- **shot.png** (from ENG-1 description): `/w/.attachments/ENG-1/shot.png`\n" +
        "- attachment (from Linear thread, ENG-2): could not be downloaded (HTTP 401). Don't guess what it shows; say so if it matters.",
    );
    expect(formatAttachments([])).toBeUndefined();
    expect(failedAttachmentsNote([files[1]!], 2)).toBe(
      "I couldn't download 1 of 2 attachment(s) from Linear, so I can't see them:\n\n- attachment (Linear thread, ENG-2): HTTP 401",
    );
    expect(failedAttachmentsNote([], 2)).toBeUndefined();
  });
});
