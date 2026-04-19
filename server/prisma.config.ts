import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "prisma/config";
import { PrismaLibSql } from "@prisma/adapter-libsql";

/** Same layout as {@link AppPaths.dataDir}: `server/data/app.db` (absolute `file:` URL). */
const DEFAULT_DB_URL = `file:${path.join(import.meta.dirname, "data", "app.db")}`;

/**
 * Reads `databaseUrl` from `server/.app-runtime-config.json` only (no `src/` import), so
 * `npx prisma db push` works from a release tarball that contains `dist/` but not TypeScript sources.
 * Precedence matches {@link getMergedAppEnv}: runtime file beats `process.env` (e.g. from `.env`).
 */
function readDatabaseUrlFromAppRuntimeConfig(serverRoot: string): string | undefined {
  const p = path.join(serverRoot, ".app-runtime-config.json");
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const o = JSON.parse(raw) as { version?: unknown; databaseUrl?: unknown };
    if (!o || o.version !== 1) {
      return undefined;
    }
    if (typeof o.databaseUrl !== "string") {
      return undefined;
    }
    const t = o.databaseUrl.trim();
    return t || undefined;
  } catch {
    return undefined;
  }
}

function resolveDatabaseUrl(): string {
  const serverRoot = import.meta.dirname;
  return (
    readDatabaseUrlFromAppRuntimeConfig(serverRoot) ??
    process.env["DATABASE_URL"]?.trim() ??
    DEFAULT_DB_URL
  );
}

const prismaDatasourceUrl = resolveDatabaseUrl();

export default defineConfig({
  schema: "./prisma/schema.prisma",
  datasource: {
    url: prismaDatasourceUrl,
  },
  migrate: {
    async adapter(env: Record<string, string | undefined>) {
      const url = env["DATABASE_URL"]?.trim() || prismaDatasourceUrl;
      return new PrismaLibSql({ url });
    },
  },
});
