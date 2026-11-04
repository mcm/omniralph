import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { getObjectStorage, ObjectStorageError, s3ObjectStorage } = await import("./storage");

const config = {
  endpoint: "https://storage.example.com/",
  bucket: "attachments",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "secret",
};

function bucket(respond: (request: Request) => Response) {
  const requests: Request[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const request = input as Request;
    requests.push(request);
    return respond(request);
  });
  return { storage: s3ObjectStorage(config, fetchImpl as typeof fetch), requests };
}

describe("s3ObjectStorage", () => {
  it("puts a file path-style under the bucket, signed with SigV4 for s3", async () => {
    const { storage, requests } = bucket(() => new Response(null, { status: 200 }));
    await storage.put("attachments/org/id", new Uint8Array([1, 2, 3]), "image/png");
    const [request] = requests;
    expect(request!.method).toBe("PUT");
    expect(request!.url).toBe("https://storage.example.com/attachments/attachments/org/id");
    expect(request!.headers.get("content-type")).toBe("image/png");
    expect(request!.headers.get("authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request, /,
    );
    expect(new Uint8Array(await request!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("reads a file back, and a missing one as null", async () => {
    const { storage } = bucket((request) =>
      request.url.endsWith("/missing")
        ? new Response("NoSuchKey", { status: 404 })
        : new Response("hello", { status: 200 }),
    );
    const found = await storage.get("attachments/org/present");
    expect(await new Response(found!.body).text()).toBe("hello");
    expect(await storage.get("attachments/org/missing")).toBeNull();
  });

  it("treats deleting a missing file as done", async () => {
    const { storage, requests } = bucket(() => new Response(null, { status: 404 }));
    await expect(storage.delete("attachments/org/gone")).resolves.toBeUndefined();
    expect(requests[0]!.method).toBe("DELETE");
  });

  it("fails with the service's answer on an error", async () => {
    const { storage } = bucket(() => new Response("AccessDenied", { status: 403 }));
    await expect(storage.put("k", new Uint8Array(), "text/plain")).rejects.toThrow(
      ObjectStorageError,
    );
    await expect(storage.get("k")).rejects.toThrow(/answered 403: AccessDenied/);
    await expect(storage.delete("k")).rejects.toThrow(ObjectStorageError);
  });
});

describe("getObjectStorage", () => {
  it("is off unless the endpoint, bucket and both keys are set", () => {
    const env = {
      OBJECT_STORAGE_ENDPOINT: "https://storage.example.com",
      OBJECT_STORAGE_BUCKET: "attachments",
      OBJECT_STORAGE_ACCESS_KEY_ID: "id",
      OBJECT_STORAGE_SECRET_ACCESS_KEY: "secret",
    };
    expect(getObjectStorage(env)).not.toBeNull();
    expect(getObjectStorage({ ...env, OBJECT_STORAGE_SECRET_ACCESS_KEY: "" })).toBeNull();
    expect(getObjectStorage({})).toBeNull();
  });
});
