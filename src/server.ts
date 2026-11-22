import express, { type NextFunction, type Request, type Response } from "express";
import swaggerUi from "swagger-ui-express";
import { config } from "./config.js";
import { ensureSchema, pool } from "./db.js";
import { logger } from "./logger.js";
import { openApiDocument } from "./openapi.js";
import { authRouter } from "./routes/auth.js";
import { clientesRouter } from "./routes/clientes.js";
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

// Rotas no padrao da API antiga: /api/auth/login e /api/mid/avec/salao/{salao_id}/...
app.use("/api", authRouter, clientesRouter, comandasRouter, relatoriosRouter);

// Rota inexistente (mesmo formato/mensagem da API antiga)
app.use((req: Request, res: Response) => {
  res.status(404).json({
    code: 404,
    message: `The route ${req.path.replace(/^\//, "")} could not be found.`,
    file: null,
    line: null,
    trace: null,
  });
});

// JSON invalido e demais erros
app.use((err: Error & { type?: string }, _req: Request, res: Response, _next: NextFunction) => {
  if (err.type === "entity.parse.failed") {
    res.status(400).json({ code: 400, message: "Body JSON invalido", file: null, line: null, trace: null });
    return;
  }
  logger.error({ err: err.message }, "unhandled_error");
  res.status(500).json({ code: 500, message: "Erro interno", file: null, line: null, trace: null });
});

// Banco remoto pode demorar a responder na partida: tenta algumas vezes antes de desistir.
for (let attempt = 1; ; attempt++) {
  try {
    await ensureSchema();
    break;
  } catch (err) {
    if (attempt >= 5) throw err;
    logger.warn({ attempt, err: (err as Error).message }, "db_schema_retry");
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
}

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
