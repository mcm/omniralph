import type * as VercelBlob from "@vercel/blob";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const blob = vi.hoisted(() => ({
  put: vi.fn(),
  get: vi.fn(),
  del: vi.fn(),
}));

vi.mock("@vercel/blob", async (importOriginal) => {
  const actual = await importOriginal<typeof VercelBlob>();
  return { ...actual, put: blob.put, get: blob.get, del: blob.del };
});

const { BlobError } = await import("@vercel/blob");
const { getObjectStorage, ObjectStorageError, vercelBlobStorage } = await import("./storage");

beforeEach(() => {
  blob.put.mockReset();
  blob.get.mockReset();
  blob.del.mockReset();
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

describe("getObjectStorage", () => {
  it("is off unless the blob store's read-write token is set", () => {
    expect(getObjectStorage({ BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_x" })).not.toBeNull();
    expect(getObjectStorage({ BLOB_READ_WRITE_TOKEN: "" })).toBeNull();
    expect(getObjectStorage({})).toBeNull();
  });
});
