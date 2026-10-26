import { describe, expect, it } from "vitest";
import { mergeSessionPages, sessionSections } from "./session";
import { EMPTY_SESSION, runSession } from "./test-fixtures";

describe("sessionSections", () => {
  it("lists the subsections with something to show, in order", () => {
    expect(sessionSections(runSession())).toEqual([
      "pendingRequests",
      "messages",
      "guidance",
      "recommendations",
      "progressLog",
    ]);
    expect(sessionSections(runSession({ messages: [], progressLog: " \n" }))).toEqual([
      "pendingRequests",
      "guidance",
      "recommendations",
    ]);
    expect(sessionSections(EMPTY_SESSION)).toEqual([]);
  });
});

describe("mergeSessionPages", () => {
  it("appends the older pages' messages once, and takes the last page's cursor", () => {
    const first = runSession({ nextCursor: "c2" });
    const [newest, older] = first.messages;
    const second = runSession({
      messages: [older!, { ...older!, id: "message-0" }],
      nextCursor: null,
    });
    expect(mergeSessionPages([first, second])).toEqual({
      ...first,
      messages: [newest, older, { ...older!, id: "message-0" }],
      nextCursor: null,
    });
    expect(mergeSessionPages([])).toBeNull();
  });
});
