import "server-only";
import { AwsClient } from "aws4fetch";

/**
 * Object storage for attachment files: any S3-compatible bucket (Amazon S3, Cloudflare R2,
 * Neon object storage, MinIO), addressed path-style (`<endpoint>/<bucket>/<key>`) and signed
 * with SigV4. Files never go in the database; the `attachments` table keeps their keys.
 */

/** A stored file read back. */
export interface StoredObject {
  body: ReadableStream<Uint8Array>;
}

export interface ObjectStorage {
  put(key: string, body: Uint8Array<ArrayBuffer>, contentType: string): Promise<void>;
  /** The file under `key`, or null when there is none. */
  get(key: string): Promise<StoredObject | null>;
  /** Deletes the file under `key`; a missing file is not an error. */
  delete(key: string): Promise<void>;
}

/** Object storage answered with an error. */
export class ObjectStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectStorageError";
  }
}

export interface S3StorageConfig {
  /** The service's base URL, e.g. `https://<account>.r2.cloudflarestorage.com`. */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Default `auto` (R2); Amazon S3 needs the bucket's region. */
  region?: string;
}

/** An S3-compatible bucket. `fetch` is injectable for tests. */
export function s3ObjectStorage(
  config: S3StorageConfig,
  fetchImpl: typeof fetch = fetch,
): ObjectStorage {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: config.region || "auto",
  });
  const base = `${config.endpoint.replace(/\/+$/, "")}/${encodeURIComponent(config.bucket)}`;
  const url = (key: string) => `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;

  const send = async (key: string, init: RequestInit): Promise<Response> => {
    const signed = await client.sign(url(key), init);
    return fetchImpl(signed);
  };
  const fail = async (what: string, key: string, response: Response): Promise<never> => {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new ObjectStorageError(
      `Object storage ${what} of ${key} answered ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  };

  return {
    async put(key, body, contentType) {
      const response = await send(key, {
        method: "PUT",
        body,
        headers: { "content-type": contentType, "content-length": String(body.byteLength) },
      });
      if (!response.ok) await fail("upload", key, response);
      await response.body?.cancel();
    },
    async get(key) {
      const response = await send(key, { method: "GET" });
      if (response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      if (!response.ok || !response.body) return fail("download", key, response);
      return { body: response.body };
    },
    async delete(key) {
      const response = await send(key, { method: "DELETE" });
      if (!response.ok && response.status !== 404) await fail("delete", key, response);
      await response.body?.cancel();
    },
  };
}

/** A bucket in memory, for tests. */
export function memoryObjectStorage(): ObjectStorage & {
  files: Map<string, Uint8Array<ArrayBuffer>>;
} {
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  return {
    files,
    async put(key, body) {
      files.set(key, new Uint8Array(body));
    },
    async get(key) {
      const file = files.get(key);
      if (!file) return null;
      return { body: new Blob([file]).stream() };
    },
    async delete(key) {
      files.delete(key);
    },
  };
}

/** The configured bucket (`OBJECT_STORAGE_*`), or null when attachments aren't set up. */
export function getObjectStorage(
  env: Record<string, string | undefined> = process.env,
): ObjectStorage | null {
  const endpoint = env.OBJECT_STORAGE_ENDPOINT;
  const bucket = env.OBJECT_STORAGE_BUCKET;
  const accessKeyId = env.OBJECT_STORAGE_ACCESS_KEY_ID;
  const secretAccessKey = env.OBJECT_STORAGE_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return s3ObjectStorage({
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: env.OBJECT_STORAGE_REGION,
  });
}
