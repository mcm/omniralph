import { randomBytes } from "node:crypto";
import {
  attachments,
  closeDb,
  connectRepository,
  createDb,
  createOrganization,
  featureDocuments,
  features,
  linkFeatureEpic,
  saveIntegration,
  upsertScmConnection,
  users,
  type Database,
} from "@omniralph/db";
import { captureChanges } from "@omniralph/db/changes";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { FakeLinearGateway } from "@omniralph/tracker/linear/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachmentListSchema,
  featureDocumentSchema,
  featureDocumentVersionsSchema,
  featureListSchema,
  featureRowSchema,
  MAX_ATTACHMENT_BYTES,
  savedFeatureDocumentSchema,
  savedFeatureSchema,
  uploadedAttachmentSchema,
  type AttachmentRow,
  type FeatureRow,
} from "@/lib/api/features";
import type * as Storage from "@/lib/attachments/storage";
import { assertRole, type Role } from "@/lib/auth/roles";
import type * as LinearClient from "@/lib/tracker/linear/client";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  orgId: "",
  storage: null as Storage.ObjectStorage | null,
  linear: new Map<string, FakeLinearGateway>(),
}));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") =>
    assertRole(
      {
        id: "feature-user",
        role: "member",
        name: "Ada",
        email: null,
        image: null,
        organization: { id: state.orgId, name: "Acme" },
      },
      role,
    ),
}));
vi.mock("@/lib/attachments/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof Storage>();
  return { ...actual, getObjectStorage: () => state.storage };
});
vi.mock("@/lib/tracker/linear/client", async (importOriginal) => {
  const actual = await importOriginal<typeof LinearClient>();
  return {
    ...actual,
    getLinearGateway: async (options: LinearClient.LinearGatewayOptions) => {
      const gateway = state.linear.get(options.organizationId);
      if (!gateway) throw new actual.LinearNotConnectedError();
      return gateway;
    },
  };
});

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const { memoryObjectStorage } = await import("@/lib/attachments/storage");
const list = await import("./route");
const one = await import("./[id]/route");
const document = await import("./[id]/documents/[kind]/route");
const versions = await import("./[id]/documents/[kind]/versions/route");
const featureAttachments = await import("./[id]/attachments/route");
const workItemAttachments = await import("../work-items/[id]/attachments/route");
const attachment = await import("../attachments/[id]/route");

type Handler = (
  request: Request,
  route: { params: Promise<Record<string, string>> },
) => Promise<Response>;

async function send(
  handler: unknown,
  method: string,
  params: Record<string, string> = {},
  init: { body?: unknown; form?: FormData; search?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const json = init.body !== undefined;
  return (handler as Handler)(
    new Request(`http://localhost/api/ui/features${init.search ?? ""}`, {
      method,
      headers: { ...(json ? { "content-type": "application/json" } : {}), ...init.headers },
      body: json ? JSON.stringify(init.body) : init.form,
    }),
    { params: Promise.resolve(params) },
  );
}

async function call(
  handler: unknown,
  method: string,
  params: Record<string, string> = {},
  init: Parameters<typeof send>[3] = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await send(handler, method, params, init);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function fileForm(name: string, type: string, bytes: Uint8Array | string): FormData {
  const form = new FormData();
  form.set("file", new File([bytes as BlobPart], name, { type }));
  return form;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("/api/ui/features and attachments", () => {
  let testDb: TestDatabase;
  let db: Database;
  let repoId: string;
  let otherOrgId: string;
  let otherOrgRepoId: string;
  let storage: ReturnType<typeof memoryObjectStorage>;
  let linear: FakeLinearGateway;

  const repo = async (organizationId: string, fullPath: string) => {
    const connection = (await upsertScmConnection(
      db,
      {
        organizationId,
        provider: "github",
        name: fullPath,
        baseUrl: "https://api.github.com",
        externalId: `installation-${fullPath}`,
        credentials: {},
      },
      randomBytes(32),
    ))!;
    const { id } = await connectRepository(db, {
      connectionId: connection.id,
      provider: "github",
      externalId: fullPath,
      fullPath,
    });
    return id;
  };

  const created = async (body: Record<string, unknown> = {}): Promise<FeatureRow> => {
    const result = await call(list.POST, "POST", {}, { body: { name: "Checkout", ...body } });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    return savedFeatureSchema.parse(result.body).feature;
  };
  const save = (featureId: string, kind: string, body: string, baseVersion: number) =>
    call(document.PUT, "PUT", { id: featureId, kind }, { body: { body, baseVersion } });
  const upload = (featureId: string, form: FormData, headers?: Record<string, string>) =>
    call(featureAttachments.POST, "POST", { id: featureId }, { form, headers });
  const uploaded = async (featureId: string, form: FormData): Promise<AttachmentRow> => {
    const result = await upload(featureId, form);
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    return uploadedAttachmentSchema.parse(result.body).attachment;
  };

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    state.db = db;
    await db.insert(users).values([
      { id: "feature-user", name: "Ada" },
      { id: "other-user", name: "Grace" },
    ]);
    const org = await createOrganization(db, { name: "Acme", createdBy: "feature-user" });
    // The user isn't a member of the other organization.
    const other = await createOrganization(db, { name: "Other", createdBy: "other-user" });
    state.orgId = org.id;
    otherOrgId = other.id;
    repoId = await repo(org.id, "acme/web");
    otherOrgRepoId = await repo(other.id, "other/web");

    linear = new FakeLinearGateway();
    const integration = await saveIntegration(db, {
      organizationId: org.id,
      provider: "linear",
      externalId: "workspace-acme",
      name: "Acme",
      credentials: { accessToken: "t" },
      installedByUserId: null,
    });
    if (integration === "other_organization") throw new Error("setup");
    state.linear.set(org.id, linear);
  });

  beforeEach(async () => {
    storage = memoryObjectStorage();
    state.storage = storage;
    await db.delete(attachments);
    await db.delete(features);
  });

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  describe("features", () => {
    it("creates a feature in planning, scoped to a repo, and publishes a feature change", async () => {
      const { result, changes } = await captureChanges(() =>
        call(list.POST, "POST", {}, { body: { name: "  Checkout  ", repositoryId: repoId } }),
      );
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      const feature = savedFeatureSchema.parse(result.body).feature;
      expect(feature).toMatchObject({
        name: "Checkout",
        status: "planning",
        repository: { id: repoId, fullPath: "acme/web" },
      });
      expect(changes.map((c) => [c.resource, c.ids])).toEqual([["feature", [feature.id]]]);
    });

    it("creates a feature with no repo scope", async () => {
      expect((await created()).repository).toBeNull();
    });

    it("refuses another organization's repo and an empty name", async () => {
      const otherRepo = await call(
        list.POST,
        "POST",
        {},
        { body: { name: "Checkout", repositoryId: otherOrgRepoId } },
      );
      expect(otherRepo.status).toBe(400);
      expect(otherRepo.body.code).toBe("unknown_repository");
      const unnamed = await call(list.POST, "POST", {}, { body: { name: "   " } });
      expect(unnamed.status).toBe(400);
      expect(await db.select().from(features)).toEqual([]);
    });

    it("lists the organization's features newest first, never another organization's", async () => {
      const first = await created({ name: "First" });
      const second = await created({ name: "Second" });
      await db.insert(features).values({ organizationId: otherOrgId, name: "Theirs" });
      const result = await call(list.GET, "GET");
      expect(result.status).toBe(200);
      const listed = featureListSchema.parse(result.body).features;
      expect(listed.map((f) => f.id)).toEqual([second.id, first.id]);
    });

    it("counts each feature's epics, moving an epic linked to another feature", async () => {
      const first = await created({ name: "First" });
      const second = await created({ name: "Second" });
      expect(first.epicCount).toBe(0);
      const epic = (externalId: string, featureId: string) =>
        linkFeatureEpic(db, {
          organizationId: state.orgId,
          tracker: "linear",
          externalId,
          featureId,
        });
      await epic("issue-1", first.id);
      await epic("issue-2", first.id);
      await epic("issue-3", second.id);
      const { changes } = await captureChanges(() => epic("issue-2", second.id));
      expect(changes.map((c) => c.ids)).toEqual([[second.id, first.id]]);
      const listed = featureListSchema.parse((await call(list.GET, "GET")).body).features;
      expect(Object.fromEntries(listed.map((f) => [f.name, f.epicCount]))).toEqual({
        First: 1,
        Second: 2,
      });
    });

    it("reads one feature; another organization's is 404", async () => {
      const feature = await created();
      const result = await call(one.GET, "GET", { id: feature.id });
      expect(featureRowSchema.parse(result.body)).toEqual(feature);
      const [theirs] = await db
        .insert(features)
        .values({ organizationId: otherOrgId, name: "Theirs" })
        .returning();
      expect((await call(one.GET, "GET", { id: theirs!.id })).status).toBe(404);
    });

    it("renames a feature and changes its repo", async () => {
      const feature = await created();
      const { result, changes } = await captureChanges(() =>
        call(
          one.PATCH,
          "PATCH",
          { id: feature.id },
          { body: { name: "Payments", repositoryId: repoId } },
        ),
      );
      expect(result.status).toBe(200);
      expect(savedFeatureSchema.parse(result.body).feature).toMatchObject({
        name: "Payments",
        repository: { id: repoId },
      });
      expect(changes.map((c) => [c.resource, c.ids])).toEqual([["feature", [feature.id]]]);
      const unscoped = await call(
        one.PATCH,
        "PATCH",
        { id: feature.id },
        { body: { repositoryId: null } },
      );
      expect(savedFeatureSchema.parse(unscoped.body).feature.repository).toBeNull();
    });

    it("archives and restores a feature", async () => {
      const feature = await created();
      const archived = await call(
        one.PATCH,
        "PATCH",
        { id: feature.id },
        { body: { archived: true } },
      );
      expect(savedFeatureSchema.parse(archived.body).feature.status).toBe("archived");
      const restored = await call(
        one.PATCH,
        "PATCH",
        { id: feature.id },
        { body: { archived: false } },
      );
      expect(savedFeatureSchema.parse(restored.body).feature.status).toBe("planning");
    });

    it("refuses an update with nothing to change, and another organization's feature", async () => {
      const feature = await created();
      expect((await call(one.PATCH, "PATCH", { id: feature.id }, { body: {} })).status).toBe(400);
      const [theirs] = await db
        .insert(features)
        .values({ organizationId: otherOrgId, name: "Theirs" })
        .returning();
      const result = await call(one.PATCH, "PATCH", { id: theirs!.id }, { body: { name: "Mine" } });
      expect(result.status).toBe(404);
      const [kept] = await db.select().from(features).where(eq(features.id, theirs!.id));
      expect(kept!.name).toBe("Theirs");
    });
  });

  describe("documents", () => {
    it("reads a document never saved as version 0, empty", async () => {
      const feature = await created();
      const result = await call(document.GET, "GET", { id: feature.id, kind: "prfaq" });
      expect(featureDocumentSchema.parse(result.body)).toEqual({
        kind: "prfaq",
        version: 0,
        body: "",
        savedAt: null,
      });
    });

    it("saves each document as a new version, keeping the earlier ones", async () => {
      const feature = await created();
      const { result: first, changes } = await captureChanges(() =>
        save(feature.id, "plan", "# Plan v1", 0),
      );
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(savedFeatureDocumentSchema.parse(first.body).document).toMatchObject({
        kind: "plan",
        version: 1,
        body: "# Plan v1",
      });
      expect(changes.map((c) => [c.resource, c.ids])).toEqual([["feature", [feature.id]]]);
      expect((await save(feature.id, "plan", "# Plan v2", 1)).status).toBe(200);
      // The PRFAQ has versions of its own.
      expect((await save(feature.id, "prfaq", "# PRFAQ", 0)).status).toBe(200);

      const latest = await call(document.GET, "GET", { id: feature.id, kind: "plan" });
      expect(featureDocumentSchema.parse(latest.body)).toMatchObject({
        version: 2,
        body: "# Plan v2",
      });
      const earlier = await call(
        document.GET,
        "GET",
        { id: feature.id, kind: "plan" },
        { search: "?version=1" },
      );
      expect(featureDocumentSchema.parse(earlier.body)).toMatchObject({
        version: 1,
        body: "# Plan v1",
      });
      const history = await call(versions.GET, "GET", { id: feature.id, kind: "plan" });
      expect(
        featureDocumentVersionsSchema
          .parse(history.body)
          .versions.map((v) => [v.version, v.savedBy]),
      ).toEqual([
        [2, "Ada"],
        [1, "Ada"],
      ]);
    });

    it("refuses a save against a stale version, writing nothing", async () => {
      const feature = await created();
      await save(feature.id, "plan", "Mine", 0);
      await save(feature.id, "plan", "Theirs", 1);
      const { result, changes } = await captureChanges(() =>
        save(feature.id, "plan", "Mine, from version 1", 1),
      );
      expect(result.status).toBe(409);
      expect(result.body.code).toBe("stale_version");
      expect(changes).toEqual([]);
      // A first save when someone already saved is stale too.
      expect((await save(feature.id, "plan", "Also mine", 0)).status).toBe(409);
      const rows = await db
        .select({ version: featureDocuments.version, body: featureDocuments.body })
        .from(featureDocuments)
        .where(eq(featureDocuments.featureId, feature.id));
      expect(rows.sort((a, b) => a.version - b.version)).toEqual([
        { version: 1, body: "Mine" },
        { version: 2, body: "Theirs" },
      ]);
    });

    it("lets only one of two concurrent saves from the same version through", async () => {
      const feature = await created();
      const results = await Promise.all([
        save(feature.id, "prfaq", "A", 0),
        save(feature.id, "prfaq", "B", 0),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    });

    it("refuses saves to an archived feature", async () => {
      const feature = await created();
      await call(one.PATCH, "PATCH", { id: feature.id }, { body: { archived: true } });
      const result = await save(feature.id, "plan", "Plan", 0);
      expect(result.status).toBe(409);
      expect(result.body.code).toBe("archived");
    });

    it("answers 404 for an unknown kind, a missing version and another organization's feature", async () => {
      const feature = await created();
      expect((await call(document.GET, "GET", { id: feature.id, kind: "spec" })).status).toBe(404);
      expect((await save(feature.id, "spec", "x", 0)).status).toBe(404);
      const missing = await call(
        document.GET,
        "GET",
        { id: feature.id, kind: "plan" },
        { search: "?version=3" },
      );
      expect(missing.status).toBe(404);
      const [theirs] = await db
        .insert(features)
        .values({ organizationId: otherOrgId, name: "Theirs" })
        .returning();
      expect((await call(document.GET, "GET", { id: theirs!.id, kind: "plan" })).status).toBe(404);
      expect((await save(theirs!.id, "plan", "x", 0)).status).toBe(404);
      expect((await call(versions.GET, "GET", { id: theirs!.id, kind: "plan" })).status).toBe(404);
    });
  });

  describe("attachments", () => {
    it("uploads a file to object storage, keeping only its metadata in the database", async () => {
      const feature = await created();
      const { result, changes } = await captureChanges(() =>
        upload(feature.id, fileForm("board.png", "image/png", PNG)),
      );
      expect(result.status, JSON.stringify(result.body)).toBe(201);
      const row = uploadedAttachmentSchema.parse(result.body).attachment;
      expect(row).toMatchObject({
        fileName: "board.png",
        contentType: "image/png",
        size: PNG.length,
      });
      expect(changes.map((c) => [c.resource, c.ids])).toEqual([["feature", [feature.id]]]);

      const [stored] = await db.select().from(attachments).where(eq(attachments.id, row.id));
      expect(stored).toMatchObject({
        featureId: feature.id,
        tracker: null,
        externalId: null,
        size: PNG.length,
        storageKey: `attachments/${state.orgId}/${row.id}`,
      });
      expect(storage.files.get(stored!.storageKey)).toEqual(PNG);
    });

    it("lists a feature's attachments oldest first", async () => {
      const feature = await created();
      const a = await uploaded(feature.id, fileForm("a.png", "image/png", PNG));
      const b = await uploaded(feature.id, fileForm("b.pdf", "application/pdf", "%PDF-1.7"));
      const other = await created({ name: "Other" });
      await uploaded(other.id, fileForm("c.png", "image/png", PNG));
      const result = await call(featureAttachments.GET, "GET", { id: feature.id });
      expect(attachmentListSchema.parse(result.body).attachments.map((x) => x.id)).toEqual([
        a.id,
        b.id,
      ]);
    });

    it("serves images inline and other files, or any with download=1, as downloads", async () => {
      const feature = await created();
      const image = await uploaded(feature.id, fileForm("mock up.png", "image/png", PNG));
      const shown = await send(attachment.GET, "GET", { id: image.id });
      expect(shown.status).toBe(200);
      expect(shown.headers.get("content-type")).toBe("image/png");
      expect(shown.headers.get("content-disposition")).toMatch(/^inline; filename="mock up.png"/);
      expect(shown.headers.get("x-content-type-options")).toBe("nosniff");
      expect(new Uint8Array(await shown.arrayBuffer())).toEqual(PNG);

      const saved = await send(attachment.GET, "GET", { id: image.id }, { search: "?download=1" });
      expect(saved.headers.get("content-disposition")).toMatch(/^attachment;/);
      const notes = await uploaded(feature.id, fileForm("notes.md", "text/markdown", "# Notes"));
      const text = await send(attachment.GET, "GET", { id: notes.id });
      expect(text.headers.get("content-disposition")).toMatch(/^attachment;/);
      expect(await text.text()).toBe("# Notes");
    });

    it("deletes an attachment and its file", async () => {
      const feature = await created();
      const row = await uploaded(feature.id, fileForm("a.png", "image/png", PNG));
      const { result, changes } = await captureChanges(() =>
        call(attachment.DELETE, "DELETE", { id: row.id }),
      );
      expect(result.status).toBe(200);
      expect(changes.map((c) => [c.resource, c.ids])).toEqual([["feature", [feature.id]]]);
      expect(await db.select().from(attachments)).toEqual([]);
      expect(storage.files.size).toBe(0);
      expect((await call(attachment.DELETE, "DELETE", { id: row.id })).status).toBe(404);
      expect((await call(attachment.GET, "GET", { id: row.id })).status).toBe(404);
    });

    it("refuses a file over the size limit with 413, storing nothing", async () => {
      const feature = await created();
      const big = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
      const result = await upload(feature.id, fileForm("big.png", "image/png", big));
      expect(result.status).toBe(413);
      expect(result.body.code).toBe("too_large");
      // A body announced as too large is refused before it's read.
      const announced = await upload(feature.id, fileForm("a.png", "image/png", PNG), {
        "content-length": String(MAX_ATTACHMENT_BYTES * 2),
      });
      expect(announced.status).toBe(413);
      expect(storage.files.size).toBe(0);
      expect(await db.select().from(attachments)).toEqual([]);
    });

    it("takes a file of exactly the size limit", async () => {
      const feature = await created();
      const row = await uploaded(
        feature.id,
        fileForm("max.pdf", "application/pdf", new Uint8Array(MAX_ATTACHMENT_BYTES)),
      );
      expect(row.size).toBe(MAX_ATTACHMENT_BYTES);
    });

    it("refuses a disallowed type with 400, by its declared type or its extension", async () => {
      const feature = await created();
      for (const form of [
        fileForm("page.html", "text/html", "<script>alert(1)</script>"),
        fileForm("logo.svg", "image/svg+xml", "<svg/>"),
        fileForm("tool.exe", "", "MZ"),
        fileForm("archive", "application/octet-stream", "PK"),
      ]) {
        const result = await upload(feature.id, form);
        expect(result.status).toBe(400);
        expect(result.body.code).toBe("disallowed_type");
      }
      expect(storage.files.size).toBe(0);
    });

    it("recognizes a file without a declared type by its extension", async () => {
      const feature = await created();
      const row = await uploaded(feature.id, fileForm("spec.MD", "", "# Spec"));
      expect(row.contentType).toBe("text/markdown");
    });

    it("refuses an upload without a file, and keeps only the file's own name", async () => {
      const feature = await created();
      const empty = await upload(feature.id, new FormData());
      expect(empty.status).toBe(400);
      expect(empty.body.code).toBe("no_file");
      const row = await uploaded(feature.id, fileForm("../../etc/notes.txt", "text/plain", "hi"));
      expect(row.fileName).toBe("notes.txt");
    });

    it("refuses uploads to an archived feature and to another organization's", async () => {
      const feature = await created();
      await call(one.PATCH, "PATCH", { id: feature.id }, { body: { archived: true } });
      const archived = await upload(feature.id, fileForm("a.png", "image/png", PNG));
      expect(archived.status).toBe(409);
      const [theirs] = await db
        .insert(features)
        .values({ organizationId: otherOrgId, name: "Theirs" })
        .returning();
      expect((await upload(theirs!.id, fileForm("a.png", "image/png", PNG))).status).toBe(404);
      expect((await call(featureAttachments.GET, "GET", { id: theirs!.id })).status).toBe(404);
      expect(storage.files.size).toBe(0);
    });

    it("never serves or deletes another organization's attachment", async () => {
      const [theirs] = await db
        .insert(features)
        .values({ organizationId: otherOrgId, name: "Theirs" })
        .returning();
      const [row] = await db
        .insert(attachments)
        .values({
          organizationId: otherOrgId,
          featureId: theirs!.id,
          fileName: "secret.png",
          contentType: "image/png",
          size: 3,
          storageKey: `attachments/${otherOrgId}/secret`,
        })
        .returning();
      storage.files.set(row!.storageKey, new Uint8Array([1, 2, 3]));
      expect((await call(attachment.GET, "GET", { id: row!.id })).status).toBe(404);
      // Naming an organization the user isn't a member of doesn't help.
      const named = await call(
        attachment.GET,
        "GET",
        { id: row!.id },
        { search: `?organization=${otherOrgId}` },
      );
      expect(named.status).toBe(404);
      expect((await call(attachment.DELETE, "DELETE", { id: row!.id })).status).toBe(404);
      expect(storage.files.size).toBe(1);
    });

    it("serves an attachment of another of the user's organizations when it's named", async () => {
      const second = await createOrganization(db, { name: "Second", createdBy: "feature-user" });
      const [theirs] = await db
        .insert(features)
        .values({ organizationId: second.id, name: "Second's" })
        .returning();
      const [row] = await db
        .insert(attachments)
        .values({
          organizationId: second.id,
          featureId: theirs!.id,
          fileName: "board.png",
          contentType: "image/png",
          size: PNG.length,
          storageKey: `attachments/${second.id}/board`,
        })
        .returning();
      storage.files.set(row!.storageKey, PNG);
      expect((await call(attachment.GET, "GET", { id: row!.id })).status).toBe(404);
      const named = await send(
        attachment.GET,
        "GET",
        { id: row!.id },
        { search: `?organization=${second.id}` },
      );
      expect(named.status).toBe(200);
      expect(new Uint8Array(await named.arrayBuffer())).toEqual(PNG);
    });

    it("answers 503 when object storage isn't configured", async () => {
      const feature = await created();
      state.storage = null;
      const result = await upload(feature.id, fileForm("a.png", "image/png", PNG));
      expect(result.status).toBe(503);
      expect(result.body.code).toBe("storage_off");
    });

    it("deletes the stored file again when recording the attachment fails", async () => {
      const feature = await created();
      const put = vi.spyOn(storage, "put").mockImplementation(async (key, body) => {
        storage.files.set(key, body);
        // The feature goes away between storing the file and recording it.
        await db.delete(features).where(eq(features.id, feature.id));
      });
      const result = await upload(feature.id, fileForm("a.png", "image/png", PNG));
      put.mockRestore();
      expect(result.status).toBe(500);
      expect(storage.files.size).toBe(0);
    });

    it("attaches files to a work item, publishing a work item change", async () => {
      const issue = linear.add({ identifier: "ENG-1", title: "Checkout epic" });
      const workItemId = `linear-${issue.id}`;
      const form = fileForm("flow.pdf", "application/pdf", "%PDF-1.7");
      const { result, changes } = await captureChanges(() =>
        call(workItemAttachments.POST, "POST", { id: workItemId }, { form }),
      );
      expect(result.status, JSON.stringify(result.body)).toBe(201);
      const row = uploadedAttachmentSchema.parse(result.body).attachment;
      expect(changes.map((c) => [c.resource, c.ids])).toEqual([["work_item", [workItemId]]]);
      const [stored] = await db.select().from(attachments).where(eq(attachments.id, row.id));
      expect(stored).toMatchObject({ featureId: null, tracker: "linear", externalId: issue.id });

      const listed = await call(workItemAttachments.GET, "GET", { id: workItemId });
      expect(attachmentListSchema.parse(listed.body).attachments.map((a) => a.id)).toEqual([
        row.id,
      ]);
      const downloaded = await send(attachment.GET, "GET", { id: row.id });
      expect(await downloaded.text()).toBe("%PDF-1.7");
      expect((await call(workItemAttachments.GET, "GET", { id: "linear-unknown" })).status).toBe(
        404,
      );
    });
  });
});
