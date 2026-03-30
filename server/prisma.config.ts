import path from "node:path";
import { defineConfig } from "prisma/config";
import { PrismaLibSql } from "@prisma/adapter-libsql";

const DEFAULT_DB_URL = `file:${path.resolve(import.meta.dirname, "../data/app.db")}`;

export default defineConfig({
  schema: "./prisma/schema.prisma",
  migrate: {
    async adapter(env: Record<string, string | undefined>) {
      const url = env["DATABASE_URL"] ?? DEFAULT_DB_URL;
      return new PrismaLibSql({ url });
    },
  },
});
