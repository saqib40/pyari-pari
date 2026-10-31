import cors from "cors";
import express, { type Express } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { corsOrigins } from "./config/env.js";
import type { AppContext } from "./context.js";
import { ping } from "./db/client.js";
import { requireMerchant } from "./helpers/auth.js";
import { errorHandler, notFoundHandler } from "./helpers/errors.js";
import { converseRoutes } from "./routes/converse.routes.js";
import { devRoutes } from "./routes/dev.routes.js";
import { entriesRoutes } from "./routes/entries.routes.js";
import { eventsRoutes } from "./routes/events.routes.js";
import { paymentsRoutes } from "./routes/payments.routes.js";
import { paytmRoutes } from "./routes/paytm.routes.js";
import { profileRoutes } from "./routes/profile.routes.js";
import { speechRoutes } from "./routes/speech.routes.js";
import { voiceRoutes } from "./routes/voice.routes.js";

export function createApp(ctx: AppContext): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  // Lets a web client on another origin (Expo web) play /api/tts/stream in an <audio> element.
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(cors({ origin: corsOrigins(ctx.env), allowedHeaders: ["Content-Type", "x-api-key"] }));
  if (ctx.env.NODE_ENV !== "test") {
    app.use(
      pinoHttp({
        logger: ctx.logger,
        autoLogging: { ignore: (req) => req.url === "/health" },
        serializers: {
          req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url }),
          res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
        },
      }),
    );
  }

  app.get("/health", async (_req, res) => {
    const dbOk = await ping(ctx.db);
    res.status(dbOk ? 200 : 503).json({
      ok: dbOk,
      db: ctx.database.kind,
      paytm: ctx.paytm.mode,
      sarvam: ctx.env.SARVAM_API_KEY ? "configured" : "missing_key",
    });
  });

  // Paytm callbacks are signature-verified and must not need an API key.
  app.use("/api", paytmRoutes(ctx));

  const api = express.Router();
  api.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: "draft-8", legacyHeaders: false }));
  api.use(express.json({ limit: "1mb" }));
  api.use(requireMerchant(ctx.db));
  api.use(profileRoutes(ctx));
  api.use(speechRoutes(ctx));
  api.use(converseRoutes(ctx));
  api.use(voiceRoutes(ctx));
  api.use(entriesRoutes(ctx));
  api.use(paymentsRoutes(ctx));
  api.use(eventsRoutes(ctx));
  if (ctx.paytm.mode === "mock") api.use(devRoutes(ctx));
  app.use("/api", api);

  app.use(notFoundHandler);
  app.use(errorHandler(ctx.logger));
  return app;
}
