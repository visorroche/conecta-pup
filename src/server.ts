import express, { type NextFunction, type Request, type Response } from "express";
import swaggerUi from "swagger-ui-express";
import { config } from "./config.js";
import { ensureSchema, pool } from "./db.js";
import { logger } from "./logger.js";
import { openApiDocument } from "./openapi.js";
import { authRouter } from "./routes/auth.js";
import { callLogMiddleware } from "./services/call-log.js";
import { comandasRouter } from "./routes/comandas.js";
import { relatoriosRouter } from "./routes/relatorios.js";
import { shutdownSessions } from "./services/session-manager.js";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));

app.get("/health", async (_req, res) => {
  let dbStatus = "ok";
  try {
    await pool.query("SELECT 1");
  } catch {
    dbStatus = "down";
  }
  const healthy = dbStatus === "ok";
  res.status(healthy ? 200 : 503).json({ status: healthy ? "ok" : "degraded", db: dbStatus });
});

app.get("/docs.json", (_req, res) => {
  res.json(openApiDocument);
});
app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));

app.use("/auth", callLogMiddleware, authRouter);
app.use("/comandas", callLogMiddleware, comandasRouter);
app.use("/relatorios", callLogMiddleware, relatoriosRouter);

// JSON invalido e demais erros
app.use((err: Error & { type?: string }, _req: Request, res: Response, _next: NextFunction) => {
  if (err.type === "entity.parse.failed") {
    res.status(400).json({ error: "invalid_json", message: "Body JSON invalido" });
    return;
  }
  logger.error({ err: err.message }, "unhandled_error");
  res.status(500).json({ error: "internal_error", message: "Erro interno" });
});

await ensureSchema();

const server = app.listen(config.PORT, config.HOST, () => {
  logger.info({ host: config.HOST, port: config.PORT, docs: `http://localhost:${config.PORT}/docs` }, "listening");
});

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  logger.info({ signal }, "shutting_down");
  server.close();
  await shutdownSessions();
  await pool.end().catch(() => undefined);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
