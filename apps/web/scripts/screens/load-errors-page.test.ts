// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { failedApiResponse, loadErrorsInPage } from "./load-errors-page.mjs";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("loadErrorsInPage", () => {
  it("counts the Runs LoadError, without its Reload button", () => {
    document.body.innerHTML = `
      <section class="or-step-panel">
        <p class="or-run-error" role="alert">Couldn't load the transcript. The server sent an
          unexpected response.<button>Reload transcript</button></p>
      </section>`;
    expect(loadErrorsInPage()).toEqual([
      "Couldn't load the transcript. The server sent an unexpected response.",
    ]);
  });

  it("counts any alert or empty state saying Couldn't load or Can't load, and the QueryBoundary", () => {
    document.body.innerHTML = `
      <div role="alert" class="or-ask-chats__error">Couldn’t load your chats <button>Retry</button></div>
      <div class="or-empty"><h2 class="or-empty__title">Can't load the attempts</h2></div>
      <div class="or-empty"><h2 class="or-empty__title">Couldn't load runs</h2></div>
      <div class="query-error" role="alert"><p>Something went wrong.</p></div>`;
    expect(loadErrorsInPage()).toEqual([
      "Couldn’t load your chats",
      "Can't load the attempts",
      "Couldn't load runs",
      "Something went wrong.",
    ]);
  });

  it("ignores other alerts and empty states, and counts a nested error once", () => {
    document.body.innerHTML = `
      <p role="alert" class="or-routing__error">Pick a repo for this rule.</p>
      <div class="or-empty"><h2 class="or-empty__title">No runs yet</h2></div>
      <div class="query-error"><div role="alert">Couldn't load the Inbox</div></div>`;
    expect(loadErrorsInPage()).toEqual(["Couldn't load the Inbox"]);
  });
});

describe("failedApiResponse", () => {
  const response = {
    surface: "panel",
    method: "GET",
    url: "http://localhost:3000/api/ui/runs/r1/attempts/a1/transcript",
    status: 200,
    contentType: "application/json",
  };

  it("fails an error status and a body that isn't JSON (Next's HTML not-found page)", () => {
    expect(failedApiResponse({ ...response, status: 404, contentType: "text/html" })).toBe(
      "GET /api/ui/runs/r1/attempts/a1/transcript: HTTP 404 (text/html)",
    );
    expect(failedApiResponse({ ...response, method: "POST", status: 502, contentType: null })).toBe(
      "POST /api/ui/runs/r1/attempts/a1/transcript: HTTP 502",
    );
    expect(failedApiResponse({ ...response, contentType: "text/html; charset=utf-8" })).toBe(
      "GET /api/ui/runs/r1/attempts/a1/transcript: HTTP 200 text/html, not JSON",
    );
  });

  it("passes JSON, event streams, redirects and empty answers", () => {
    expect(failedApiResponse(response)).toBeNull();
    expect(
      failedApiResponse({ ...response, contentType: "application/problem+json; charset=utf-8" }),
    ).toBeNull();
    expect(failedApiResponse({ ...response, contentType: "text/event-stream" })).toBeNull();
    expect(failedApiResponse({ ...response, status: 307, contentType: null })).toBeNull();
    expect(failedApiResponse({ ...response, status: 204, contentType: null })).toBeNull();
  });

  it("checks /api/ui on the panel and /api on the agent page, nothing else", () => {
    const notFound = { ...response, status: 404, contentType: "text/html" };
    expect(failedApiResponse({ ...notFound, url: "http://localhost:3000/runs/r1" })).toBeNull();
    expect(
      failedApiResponse({ ...notFound, url: "http://localhost:3000/api/auth/session" }),
    ).toBeNull();
    expect(
      failedApiResponse({ ...notFound, surface: "agent", url: "http://127.0.0.1:9/api/state" }),
    ).toBe("GET /api/state: HTTP 404 (text/html)");
  });
});
