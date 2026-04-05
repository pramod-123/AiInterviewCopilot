import "dotenv/config";
import { closeAppDatabase, openAppDatabase } from "./db.js";
import { InterviewCopilotServer } from "./InterviewCopilotServer.js";

const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || "127.0.0.1";

const server = new InterviewCopilotServer();

process.on("uncaughtException", (err, origin) => {
  try {
    server.instance.log.fatal({ err, origin }, "uncaughtException");
  } catch {
    console.error("uncaughtException", err);
  }
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  server.instance.log.error({ err }, "unhandledRejection");
});

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
    await closeAppDatabase();
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
  await openAppDatabase();

  await server.registerPlugins();
  server.registerRoutes();
  await server.registerGeminiLiveWebSocket();
  await server.listen(port, host);
} catch (err) {
  server.instance.log.error({ err }, "Failed to start server");
  process.exit(1);
}
