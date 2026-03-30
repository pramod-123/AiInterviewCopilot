import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";

const DEFAULT_DB_URL = `file:${path.resolve(import.meta.dirname, "../../data/app.db")}`;

// Prisma 7 requires an adapter for direct database connections (LibSQL for SQLite).
const adapter = new PrismaLibSql({
  url: process.env["DATABASE_URL"] ?? DEFAULT_DB_URL,
});
export const prisma = new PrismaClient({ adapter });
