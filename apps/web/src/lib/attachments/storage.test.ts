import type * as VercelBlob from "@vercel/blob";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const blob = vi.hoisted(() => ({
  put: vi.fn(),
  get: vi.fn(),
  del: vi.fn(),
  issueSignedToken: vi.fn(),
}));

vi.mock("@vercel/blob", async (importOriginal) => {
  const actual = await importOriginal<typeof VercelBlob>();
  return {
    ...actual,
    put: blob.put,
    get: blob.get,
    del: blob.del,
    issueSignedToken: blob.issueSignedToken,
  };
});

const { BlobError } = await import("@vercel/blob");
const { getObjectStorage, ObjectStorageError, vercelBlobStorage } = await import("./storage");

beforeEach(() => {
  blob.put.mockReset();
  blob.get.mockReset();
  blob.del.mockReset();
  blob.issueSignedToken.mockReset();
});

describe("vercelBlobStorage", () => {
  it("stores a file privately under its key as is, with its content type", async () => {
    blob.put.mockResolvedValue({});
    await vercelBlobStorage("token").put("attachments/org/id", new Uint8Array([1, 2]), "image/png");
    const [key, body, options] = blob.put.mock.calls[0]!;
    expect(key).toBe("attachments/org/id");
    expect(new Uint8Array(body as Buffer)).toEqual(new Uint8Array([1, 2]));
    expect(options).toMatchObject({
      access: "private",
      token: "token",
      contentType: "image/png",
      addRandomSuffix: false,
    });
  });

  it("reads a file back, and a missing one as null", async () => {
    blob.get.mockImplementation(async (key: string) =>
      key.endsWith("missing")
        ? null
        : { statusCode: 200, stream: new Blob(["hello"]).stream(), headers: new Headers() },
    );
    const storage = vercelBlobStorage("token");
    const found = await storage.get("attachments/org/present");
    expect(await new Response(found!.body).text()).toBe("hello");
    expect(await storage.get("attachments/org/missing")).toBeNull();
    expect(blob.get.mock.calls[0]![1]).toMatchObject({ access: "private", useCache: false });
  });

  it("turns the store's errors into ObjectStorageError and passes others through", async () => {
    blob.put.mockRejectedValue(new BlobError("Access denied"));
    blob.del.mockRejectedValue(new TypeError("boom"));
    const storage = vercelBlobStorage("token");
    await expect(storage.put("k", new Uint8Array(), "text/plain")).rejects.toThrow(
      ObjectStorageError,
    );
    await expect(storage.delete("k")).rejects.toThrow(TypeError);
  });
});

describe("download URLs for runs", () => {
  /** A delegation token as the store issues it: its payload names the store and scope. */
  function delegation(validUntil: number): string {
    const payload = Buffer.from(
      JSON.stringify({ storeId: "store_abc", pathname: "*", operations: ["get"], validUntil }),
    ).toString("base64url");
    return `${payload}.signature`;
  }

  it("signs each file's URL from one read-only delegation that expires when they do", async () => {
    const validUntil = new Date(Date.now() + 30 * 60_000);
    blob.issueSignedToken.mockResolvedValue({
      delegationToken: delegation(validUntil.getTime()),
      clientSigningToken: "c2lnbmluZy1rZXk",
      validUntil: validUntil.getTime(),
    });
    const urls = await vercelBlobStorage("token").downloadUrls(
      ["attachments/org/a", "attachments/org/b"],
      validUntil,
    );
    expect(blob.issueSignedToken).toHaveBeenCalledTimes(1);
    expect(blob.issueSignedToken.mock.calls[0]![0]).toEqual({
      token: "token",
      operations: ["get"],
      validUntil: validUntil.getTime(),
    });
    const a = new URL(urls.get("attachments/org/a")!);
    const b = new URL(urls.get("attachments/org/b")!);
    expect(a.pathname).toBe("/attachments/org/a");
    expect(b.pathname).toBe("/attachments/org/b");
    // Each URL carries its own signature, so one file's URL never reads another.
    const signature = (url: URL) => url.searchParams.get("vercel-blob-signature");
    expect(signature(a)).toBeTruthy();
    expect(signature(a)).not.toBe(signature(b));
  });

  it("asks the store for nothing without files", async () => {
    expect(await vercelBlobStorage("token").downloadUrls([], new Date())).toEqual(new Map());
    expect(blob.issueSignedToken).not.toHaveBeenCalled();
  });

  it("turns a refused delegation into ObjectStorageError", async () => {
    blob.issueSignedToken.mockRejectedValue(new BlobError("Access denied"));
    await expect(
      vercelBlobStorage("token").downloadUrls(["attachments/org/a"], new Date(Date.now() + 60_000)),
    ).rejects.toThrow(ObjectStorageError);
  });
});

describe("getObjectStorage", () => {
  it("is off unless the blob store's read-write token is set", () => {
    expect(getObjectStorage({ BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_x" })).not.toBeNull();
    expect(getObjectStorage({ BLOB_READ_WRITE_TOKEN: "" })).toBeNull();
    expect(getObjectStorage({})).toBeNull();
  });
});
