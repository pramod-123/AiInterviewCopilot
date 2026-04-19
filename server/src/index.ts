import "dotenv/config";
import { closeAppDatabase, openAppDatabase } from "./db.js";
import { InterviewCopilotServer } from "./InterviewCopilotServer.js";
import { AppPaths } from "./infrastructure/AppPaths.js";
import { getMergedAppEnv } from "./infrastructure/appRuntimeConfig.js";

const bootPaths = new AppPaths();
const bootEnv = getMergedAppEnv(bootPaths);
const port = Number(bootEnv.PORT?.trim() || "3001");
const host = bootEnv.HOST?.trim() || "127.0.0.1";

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
  await server.listen(port, host);
} catch (err) {
  const e = err instanceof Error ? err : new Error(String(err));
  server.instance.log.error(
    { errName: e.name, errMessage: e.message, errStack: e.stack },
    "Failed to start server",
  );
  console.error(e);
  process.exit(1);
}
