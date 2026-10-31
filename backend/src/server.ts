import { createApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { createContext } from "./context.js";
import { openDatabase } from "./db/client.js";
import { migrate } from "./db/migrate.js";
import { seedDemo, seedDemoHistory } from "./db/seed.js";
import { createLogger } from "./helpers/logger.js";

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);

const database = await openDatabase({ url: env.DATABASE_URL, pgliteDir: env.PARI_PGLITE_DIR });
const applied = await migrate(database);
if (applied.length) logger.info({ applied }, "migrations applied");
const merchant = await seedDemo(database.db, env.PARI_API_KEY);
if (env.PARI_DEMO_SEED && (await seedDemoHistory(database.db, merchant.id))) logger.info("seeded a few days of past entries");

const ctx = createContext(env, logger, database);
const app = createApp(ctx);

const server = app.listen(env.PORT, () => {
  logger.info(
    {
      port: env.PORT,
      db: database.kind === "pglite" ? `pglite (${env.PARI_PGLITE_DIR})` : "postgres",
      paytm: ctx.paytm.mode,
      sarvam: env.SARVAM_API_KEY ? "configured" : "MISSING SARVAM_API_KEY",
    },
    "Pari API ready",
  );
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  server.closeAllConnections();
  server.close();
  await database.close().catch((err) => logger.error({ err }, "error closing database"));
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
