import { describe, expect, it } from "vitest";
import { ApiError, NETWORK_ERROR, UNEXPECTED_RESPONSE } from "@/lib/api/client";
import { loadFailure } from "./load-error";

describe("loadFailure", () => {
  it("names what failed, then the server's own reason", () => {
    expect(loadFailure("diff", new ApiError("This commit isn't on GitHub yet.", 409))).toBe(
      "Couldn't load the diff. This commit isn't on GitHub yet.",
    );
  });

  it("names what failed in transit without the client's generic try again", () => {
    expect(loadFailure("diff", new ApiError(UNEXPECTED_RESPONSE, 502))).toBe(
      "Couldn't load the diff. The server sent an unexpected response.",
    );
    expect(loadFailure("transcript", new ApiError(NETWORK_ERROR, 0))).toBe(
      "Couldn't load the transcript. Couldn't reach the server.",
    );
  });

  it("says what failed when there is no reason", () => {
    expect(loadFailure("session", null)).toBe("Couldn't load the session.");
    expect(loadFailure("session", new ApiError("", 500))).toBe("Couldn't load the session.");
  });
});
