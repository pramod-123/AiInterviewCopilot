import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import type { FileStat, IAppFileStore } from "./IAppFileStore.js";

function toStat(s: Awaited<ReturnType<typeof fs.stat>>): FileStat {
  return { size: Number(s.size), isFile: s.isFile() };
}

/** {@link IAppFileStore} backed by the local filesystem (`node:fs`). */
export class NodeFsAppFileStore implements IAppFileStore {
  async mkdir(dirPath: string, options?: { recursive?: boolean }): Promise<void> {
    await fs.mkdir(dirPath, options);
  }

  async writeFile(
    filePath: string,
    data: string | Uint8Array,
    encoding?: BufferEncoding,
  ): Promise<void> {
    await fs.writeFile(filePath, data, encoding);
  }

  async readFile(filePath: string): Promise<Buffer> {
    return fs.readFile(filePath);
  }

  async copyFile(sourcePath: string, destPath: string): Promise<void> {
    await fs.copyFile(sourcePath, destPath);
  }

  async unlink(filePath: string): Promise<void> {
    await fs.unlink(filePath);
  }

  async rm(targetPath: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    await fs.rm(targetPath, options);
  }

  async stat(filePath: string): Promise<FileStat> {
    return toStat(await fs.stat(filePath));
  }

  async statOrNull(filePath: string): Promise<FileStat | null> {
    try {
      return toStat(await fs.stat(filePath));
    } catch {
      return null;
    }
  }

  async pathExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async readdir(dirPath: string): Promise<string[]> {
    return fs.readdir(dirPath);
  }

  async writeStreamFromReadable(destPath: string, source: Readable): Promise<void> {
    await pipeline(source, createWriteStream(destPath));
  }
}
