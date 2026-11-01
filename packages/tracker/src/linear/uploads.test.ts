import { describe, expect, it } from "vitest";
import { findLinearUploads, isLinearUploadUrl } from "./uploads.js";

const U = "https://uploads.linear.app/org/a1b2/c3d4";

describe("findLinearUploads", () => {
  it("reads Linear's <linear-image> blocks (signed src + title), markdown and bare URLs", () => {
    const text = `<linear-image>{"type":"image","attrs":{"src":"${U}?signature=e.y.J","title":"pavilion_contact_sheet.png"}}</linear-image>
See ![mockup](${U}/m?signature=abc) and [spec.pdf](${U}/spec) and ${U}/bare.
Again: ${U}?signature=other`;
    expect(findLinearUploads(text)).toEqual([
      { url: U, title: "pavilion_contact_sheet.png" },
      { url: `${U}/m`, title: "mockup" },
      { url: `${U}/spec`, title: "spec.pdf" },
      { url: `${U}/bare` },
    ]);
    expect(findLinearUploads("no uploads here https://example.com/x.png")).toEqual([]);
    expect(findLinearUploads(undefined)).toEqual([]);
  });

  it("finds only URLs that isLinearUploadUrl accepts", () => {
    const text = `${U}/a. <linear-image>not json</linear-image> [x](${U}/b?signature=s)`;
    const found = findLinearUploads(text);
    expect(found.map((u) => u.url)).toEqual([`${U}/b`, `${U}/a`]);
    expect(found.every((u) => isLinearUploadUrl(u.url))).toBe(true);
  });
});

describe("isLinearUploadUrl", () => {
  it("accepts only unsigned Linear upload URLs", () => {
    expect(isLinearUploadUrl(U)).toBe(true);
    expect(isLinearUploadUrl(`${U}?signature=x`)).toBe(false);
    expect(isLinearUploadUrl(`${U}.`)).toBe(false);
    expect(isLinearUploadUrl(`https://evil.example/?u=${U}`)).toBe(false);
    expect(isLinearUploadUrl("https://uploads.linear.app.evil.example/x")).toBe(false);
  });
});
