import "server-only";
import { BlobError, del, get, put } from "@vercel/blob";

/**
 * Object storage for attachment files: a private Vercel Blob store. Files never go in the
 * database; the `attachments` table keeps their keys (blob pathnames), and every download
 * goes through the control panel, which checks the reader's access first.
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
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ObjectStorageError";
  }
}

async function wrap<T>(what: string, key: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof BlobError) {
      throw new ObjectStorageError(`Object storage ${what} of ${key} failed: ${error.message}`, {
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * A private Vercel Blob store, reached with its read-write token. Keys are stored as the
 * blob's pathname as is: no random suffix (keys are already unique attachment ids), and
 * private access so a blob URL alone never serves the file.
 */
export function vercelBlobStorage(token: string): ObjectStorage {
  return {
    async put(key, body, contentType) {
      await wrap("upload", key, () =>
        put(key, Buffer.from(body.buffer, body.byteOffset, body.byteLength), {
          access: "private",
          token,
          contentType,
          addRandomSuffix: false,
        }),
      );
    },
    async get(key) {
      const result = await wrap("download", key, () =>
        get(key, { access: "private", token, useCache: false }),
      );
      if (!result || result.statusCode !== 200) return null;
      return { body: result.stream };
    },
    async delete(key) {
      await wrap("delete", key, () => del(key, { token }));
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

/**
 * The configured blob store (`BLOB_READ_WRITE_TOKEN`, set by Vercel when a Blob store is
 * connected to the project), or null when attachments aren't set up.
 */
export function getObjectStorage(
  env: Record<string, string | undefined> = process.env,
): ObjectStorage | null {
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) return null;
  return vercelBlobStorage(token);
}
