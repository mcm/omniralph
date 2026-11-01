import { describe, expect, it } from "vitest";
import {
  attachmentFileName,
  attachmentsForStory,
  failedAttachmentsNote,
  formatAttachments,
  gatherAttachments,
  uniqueFileName,
} from "./attachments.js";

const U = "https://uploads.tracker.test/org/a1b2";

/** A tracker's upload finder: `[title](url)` links and bare upload URLs, signatures dropped. */
const findUploads = (text: string | undefined | null) =>
  [...(text ?? "").matchAll(/(?:\[([^\]]*)\]\()?(https:\/\/uploads\.tracker\.test\/[\w/]+)/g)].map(
    (m) => ({ url: m[2]!, ...(m[1] && { title: m[1] }) }),
  );

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
    const gathered = gatherAttachments(
      [
        { label: "ENG-1 description", text: `![architecture.png](${U}/arch)` },
        { label: "ENG-3", text: `![badge mockup](${U}/badge?signature=x)`, storyKey: "s3" },
        { label: "comment on ENG-3 by Ana", text: `${U}/badge again`, storyKey: "s3" },
        { label: "tracker thread", text: `see ${U}/arch` },
      ],
      findUploads,
    );
    expect(gathered).toEqual([
      {
        url: `${U}/arch`,
        title: "architecture.png",
        sources: ["ENG-1 description", "tracker thread"],
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
      { title: null, sources: ["tracker thread", "ENG-2"], error: "HTTP 401" },
    ];
    expect(formatAttachments(files)).toBe(
      "- **shot.png** (from ENG-1 description): `/w/.attachments/ENG-1/shot.png`\n" +
        "- attachment (from tracker thread, ENG-2): could not be downloaded (HTTP 401). Don't guess what it shows; say so if it matters.",
    );
    expect(formatAttachments([])).toBeUndefined();
    expect(failedAttachmentsNote([files[1]!], 2)).toBe(
      "I couldn't download 1 of 2 attachment(s) from the tracker, so I can't see them:\n\n- attachment (tracker thread, ENG-2): HTTP 401",
    );
    expect(failedAttachmentsNote([], 2)).toBeUndefined();
  });
});
