import "dotenv/config";
import { prisma } from "./db.js";
import { InterviewCopilotServer } from "./InterviewCopilotServer.js";

const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || "127.0.0.1";

const server = new InterviewCopilotServer();

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  server.instance.log.info({ signal }, "Shutting down…");
  try {
    await server.instance.close();
  } catch (err) {
    server.instance.log.error({ err }, "Error while closing HTTP server");
  }
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(0);
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

try {
  await prisma.$connect();
  // SQLite: wait on locks (P1008). PRAGMA returns a row — use tagged $queryRaw (safe, static string).
  await prisma.$queryRaw`PRAGMA busy_timeout = 30000`;

  await server.registerPlugins();
  server.registerRoutes();
  await server.listen(port, host);
} catch (err) {
  server.instance.log.error(err);
  process.exit(1);
}
