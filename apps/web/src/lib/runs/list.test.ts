import * as db from "@omniralph/db";
import { describe, expect, it } from "vitest";
import { RUN_KINDS, RUN_ORIGINS, RUN_STATUSES } from "@/lib/api/runs";
import {
  ASK_RUN_TITLE_MAX_LENGTH,
  decodeRunCursor,
  encodeRunCursor,
  RUN_TITLE_MAX_LENGTH,
  runListQuerySchema,
  runListSearch,
  runRow,
} from "./list";

describe("run list values", () => {
  it("copies the read model's kinds, statuses and origins", () => {
    expect(RUN_KINDS).toEqual(db.RUN_KINDS);
    expect(RUN_STATUSES).toEqual(db.RUN_STATUSES);
    expect(RUN_ORIGINS).toEqual(db.RUN_ORIGINS);
  });
});

describe("run cursor", () => {
  const cursor = {
    createdAt: "2026-10-01T12:00:00.123456Z",
    id: "6f1c1c1e-3c2b-4c4e-9a52-0f1d7c1e2a3b",
  };

  it("round-trips, keeping microseconds", () => {
    const encoded = encodeRunCursor(cursor);
    expect(encoded).toMatch(/^[\w-]+$/);
    expect(decodeRunCursor(encoded)).toEqual(cursor);
  });

  it("refuses anything else", () => {
    for (const value of [
      "",
      "not-a-cursor",
      Buffer.from("[1, 2]").toString("base64url"),
      Buffer.from(JSON.stringify(["yesterday", cursor.id])).toString("base64url"),
      Buffer.from(JSON.stringify([cursor.createdAt, "x"])).toString("base64url"),
    ]) {
      expect(decodeRunCursor(value)).toBeNull();
    }
  });
});

describe("runListQuerySchema", () => {
  const parse = (search: string) =>
    runListQuerySchema.safeParse(runListSearch(new URLSearchParams(search)));

  it("reads repeated kinds, statuses and repositories, with a default limit", () => {
    expect(parse("kind=epic&kind=ask&status=failed").data).toEqual({
      kind: ["epic", "ask"],
      status: ["failed"],
      origin: [],
      repository: [],
      limit: 50,
    });
    const repos = ["0b7c2a7e-6f43-4c0a-9a43-2f1c3e0d5a11", "0b7c2a7e-6f43-4c0a-9a43-2f1c3e0d5a12"];
    expect(parse(`repository=${repos[0]}&repository=${repos[1]}`).data).toMatchObject({
      repository: repos,
    });
    expect(parse("organization=all&limit=100").data).toMatchObject({
      organization: "all",
      limit: 100,
    });
  });

  it("refuses unknown values", () => {
    for (const search of ["kind=coding", "status=pending", "limit=0", "limit=1.5", "agent=x"]) {
      expect(parse(search).success).toBe(false);
    }
  });
});

describe("runRow titles", () => {
  const organization = { id: "org", name: "Acme", role: "member" as const };
  const entry = (kind: db.RunKind, title: string | null): db.RunListEntry => ({
    id: "6f1c1c1e-3c2b-4c4e-9a52-0f1d7c1e2a3b",
    kind,
    organizationId: "org",
    status: "completed",
    origin: "chat",
    repositoryId: null,
    agentId: null,
    createdAt: new Date("2026-10-01T12:00:00Z"),
    updatedAt: new Date("2026-10-01T12:00:00Z"),
    createdAtKey: "2026-10-01T12:00:00.000000Z",
    title,
    tracker: null,
    workItem: null,
    repository: null,
    branch: null,
    pullRequest: null,
    agent: null,
    progress: null,
    tokens: { in: 0, out: 0 },
    startedAt: null,
    finishedAt: null,
  });

  it("titles an ask with its question, on one line of at most 120 characters", () => {
    expect(runRow(entry("ask", "  How does\n  billing\tretry work?\n\n"), organization).title).toBe(
      "How does billing retry work?",
    );
    const long = `Why ${"does the invoice job ".repeat(10)}fail?\nSecond line`;
    const title = runRow(entry("ask", long), organization).title;
    expect(ASK_RUN_TITLE_MAX_LENGTH).toBe(120);
    expect(title).toHaveLength(120);
    expect(title).not.toMatch(/\n/);
    expect(title.endsWith("…")).toBe(true);
    expect(title.startsWith("Why does the invoice job does")).toBe(true);
  });

  it("keeps longer titles for other runs, and names a run without one", () => {
    const request = "Add retries ".repeat(30);
    expect(runRow(entry("request", request), organization).title).toHaveLength(
      RUN_TITLE_MAX_LENGTH,
    );
    expect(runRow(entry("ask", "   "), organization).title).toBe("Question");
  });
});
