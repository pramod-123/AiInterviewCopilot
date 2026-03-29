import "dotenv/config";
import { prisma } from "./db.js";
import { InterviewCopilotServer } from "./InterviewCopilotServer.js";

const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || "127.0.0.1";

const server = new InterviewCopilotServer();

try {
  await prisma.$connect();

  await server.registerPlugins();
  server.registerRoutes();
  await server.listen(port, host);
} catch (err) {
  server.instance.log.error(err);
  process.exit(1);
}
