// @vitest-environment jsdom
// A route's `expectedFailures` end to end: the page and its API responses go through the same
// functions capture.mjs records them with, the result through results.json, and the
// allow-list through `captureFailures` as verify.ts applies it under `--strict`.
import { afterEach, describe, expect, it } from "vitest";
import { captureFailures, type CaptureResult } from "./checks";
import { failedApiResponse, loadErrorsInPage } from "./load-errors-page.mjs";
import type { ScreenRoute } from "./routes";

afterEach(() => {
  document.body.innerHTML = "";
});

const BASE = "http://localhost:3000";

/** A load-error fixture: the step panel's transcript the server doesn't find. */
const brokenTranscript: ScreenRoute = {
  name: "run-step-transcript-missing",
  path: "/runs/r1?step=s1",
  page: "(app)/runs/[id]/page.tsx",
  auth: "signed-in",
  expectedFailures: {
    loadErrors: ["Couldn't load the transcript."],
    responses: ["/transcript:"],
  },
};

/** What capture.mjs records for the page as it stands, written and read back as results.json. */
function capture(
  responses: { method: string; path: string; status: number; contentType: string | null }[],
): CaptureResult {
  const failedResponses: string[] = [];
  for (const { method, path, status, contentType } of responses) {
    const failure = failedApiResponse({
      surface: "panel",
      method,
      url: `${BASE}${path}`,
      status,
      contentType,
    });
    if (failure && !failedResponses.includes(failure)) failedResponses.push(failure);
  }
  const result: CaptureResult = {
    route: brokenTranscript.name,
    path: brokenTranscript.path,
    surface: "panel",
    as: "admin",
    viewport: "desktop",
    width: 1440,
    theme: "dark",
    status: 200,
    finalPath: brokenTranscript.path,
    scrollWidth: 1440,
    overflow: false,
    kbdCount: 0,
    retiredWording: [],
    consoleErrors: [],
    notRendered: null,
    loadErrors: loadErrorsInPage(),
    failedResponses,
    error: null,
    screenshot: "run-step-transcript-missing.desktop.dark.png",
    html: "run-step-transcript-missing.desktop.dark.html",
    axe: [],
    keyboard: [],
    keyboardStops: [],
    escape: null,
    landmarks: [],
    checkErrors: [],
    axeFile: null,
    ariaFile: null,
  };
  return JSON.parse(JSON.stringify(result)) as CaptureResult;
}

const TRANSCRIPT_404 = {
  method: "GET",
  path: "/api/ui/runs/r1/attempts/a1/transcript",
  status: 404,
  contentType: "text/html",
};

describe("expectedFailures through a capture", () => {
  it("lets --strict pass the load error and failed response the route declares", () => {
    document.body.innerHTML = `
      <section class="or-step-panel">
        <p class="or-run-error" role="alert">Couldn't load the transcript. The server sent an
          unexpected response.<button>Reload transcript</button></p>
      </section>`;
    const result = capture([
      { method: "GET", path: "/api/ui/runs/r1", status: 200, contentType: "application/json" },
      TRANSCRIPT_404,
    ]);
    expect(result.loadErrors).toHaveLength(1);
    expect(result.failedResponses).toHaveLength(1);
    expect(captureFailures(result, brokenTranscript, { strict: true })).toEqual([]);
    // Without the declaration the same capture fails.
    const { expectedFailures: _, ...undeclared } = brokenTranscript;
    expect(captureFailures(result, undeclared, { strict: true })).toEqual([
      "load error: Couldn't load the transcript. The server sent an unexpected response.",
      "failed API response: GET /api/ui/runs/r1/attempts/a1/transcript: HTTP 404 (text/html)",
    ]);
  });

  it("still fails --strict on what the route doesn't declare", () => {
    document.body.innerHTML = `
      <p class="or-run-error" role="alert">Couldn't load the transcript.</p>
      <div class="or-empty"><h2 class="or-empty__title">Couldn't load the diff</h2></div>`;
    const result = capture([
      TRANSCRIPT_404,
      { method: "GET", path: "/api/ui/runs/r1/steps/s1/diff", status: 200, contentType: "text/html" },
    ]);
    expect(captureFailures(result, brokenTranscript, { strict: true })).toEqual([
      "load error: Couldn't load the diff",
      "failed API response: GET /api/ui/runs/r1/steps/s1/diff: HTTP 200 text/html, not JSON",
    ]);
  });
});
