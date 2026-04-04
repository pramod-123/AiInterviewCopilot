import type { Readable } from "node:stream";

export type FileStat = {
  size: number;
  isFile: boolean;
};

/**
 * **Storage boundary** for interview data (uploads, live-session chunks, pipeline artifacts, etc.).
 *
 * **Goal:** callers depend only on this interface. To move from local disk to S3, GCS, or another
 * backend, add a new class that implements these methods and swap the default instance in
 * {@link ../../appFileStore.ts appFileStore.ts} (and any tests that inject a store).
 *
 * **Path contract:** arguments are opaque **object keys** from the app’s point of view. Today the
 * {@link NodeFsAppFileStore} interprets them as absolute filesystem paths (from `AppPaths` + `path.join`).
 * A cloud implementation would map the same strings to bucket keys (or normalize once inside the
 * adapter, e.g. strip a configured root prefix and use the remainder as the S3 key).
 *
 * **Rough S3 mapping** (for implementers): `mkdir` → often a no-op or “ensure prefix exists”;
 * `writeFile` / `readFile` → PutObject / GetObject; `copyFile` → CopyObject; `unlink` → DeleteObject;
 * `rm` recursive → batch delete under a prefix; `stat` / `statOrNull` → HeadObject; `readdir` →
 * ListObjectsV2 (delimiter `/` if you model directories); `writeStreamFromReadable` → multipart
 * upload or streaming PutObject; `pathExists` → HeadObject or ListObjects with max 1.
 *
 * @see NodeFsAppFileStore — reference implementation using `node:fs`.
 */
export interface IAppFileStore {
  mkdir(dirPath: string, options?: { recursive?: boolean }): Promise<void>;
  writeFile(filePath: string, data: string | Uint8Array, encoding?: BufferEncoding): Promise<void>;
  readFile(filePath: string): Promise<Buffer>;
  copyFile(sourcePath: string, destPath: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
  rm(targetPath: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  stat(filePath: string): Promise<FileStat>;
  /** Like {@link stat} but returns `null` if the path is missing. */
  statOrNull(filePath: string): Promise<FileStat | null>;
  pathExists(filePath: string): Promise<boolean>;
  readdir(dirPath: string): Promise<string[]>;
  writeStreamFromReadable(destPath: string, source: Readable): Promise<void>;
}
