import { Router } from "express";
import { z } from "zod";
import { logger } from "../logger.js";
import { isLoggedIn } from "../services/avec-login.js";
import { CustomerInactiveError, findBridge, findBridgeBySalaoId } from "../services/bridge.js";
import { readRelatorio } from "../services/relatorio.js";
import {
  destroySession,
  getPage,
  NoSessionError,
  SessionBusyError,
  touchSession,
  withExistingSession,
} from "../services/session-manager.js";

export const relatoriosRouter: Router = Router();

const paramsSchema = z.object({
  codigo: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,20}$/, "codigo invalido"),
});

const IDENTIFY_KEYS = new Set(["slug", "salao_id"]);

/**
 * GET /relatorios/:codigo?slug=...|salao_id=...&<filtros do relatorio>
 * Todo parametro que nao seja slug/salao_id e repassado como filtro (name do input na tela).
 */
relatoriosRouter.get("/:codigo", async (req, res) => {
  const params = paramsSchema.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({
      error: "invalid_params",
      message: "Parametros invalidos",
      details: params.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
    return;
  }
  const codigo = params.data.codigo;

  const rawSlug = typeof req.query.slug === "string" ? req.query.slug.trim().toLowerCase() : undefined;
  const rawSalao = typeof req.query.salao_id === "string" ? req.query.salao_id.trim() : undefined;
  if (rawSlug !== undefined && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(rawSlug)) {
    res.status(400).json({ error: "invalid_params", message: "slug invalido" });
    return;
  }
  const salaoId = rawSalao !== undefined ? Number(rawSalao) : undefined;
  if (salaoId !== undefined && (!Number.isInteger(salaoId) || salaoId <= 0)) {
    res.status(400).json({ error: "invalid_params", message: "salao_id invalido" });
    return;
  }
  if (rawSlug === undefined && salaoId === undefined) {
    res.status(400).json({ error: "invalid_params", message: "informe slug ou salao_id" });
    return;
  }

  const filtros: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.query)) {
    if (IDENTIFY_KEYS.has(key)) continue;
    if (typeof value !== "string") {
      res.status(400).json({ error: "invalid_params", message: `filtro "${key}" deve ser um unico valor` });
      return;
    }
    filtros[key] = value;
  }

  let slug = rawSlug;
  try {
    if (!slug) {
      const bySalao = await findBridgeBySalaoId(salaoId!);
      if (!bySalao) {
        res.status(404).json({
          error: "salao_not_found",
          message: `Nenhum cliente com salao_id ${salaoId} em customers_bridget`,
        });
        return;
      }
      slug = bySalao.slug;
    }
    const bridge = await findBridge(slug);
    if (bridge && !bridge.active) throw new CustomerInactiveError(slug);
    if (bridge?.salaoId != null && salaoId !== undefined && bridge.salaoId !== salaoId) {
      res.status(400).json({
        error: "slug_salao_mismatch",
        message: `O slug "${slug}" pertence ao salao_id ${bridge.salaoId}, nao ao ${salaoId}`,
      });
      return;
    }

    const result = await withExistingSession(slug, async ({ browser, stored }) => {
      const page = await getPage(browser, slug!, stored.sessionId);
      const state = await isLoggedIn(page, slug!);
      if (state.kind !== "logged") {
        await destroySession(slug!);
        return {
          status: 401,
          body: {
            error: "session_expired",
            message: "A sessao da AVEC expirou. Faca login novamente em POST /auth/login.",
          },
        };
      }

      const read = await readRelatorio(page, codigo, filtros);
      await touchSession(slug!);

      if (!read.ok) {
        const status =
          read.reason === "not_found"
            ? 404
            : read.reason === "session_expired"
              ? 401
              : read.reason === "timeout"
                ? 504
                : read.reason === "unsupported"
                  ? 422
                  : 400;
        const error =
          read.reason === "not_found"
            ? "relatorio_not_found"
            : read.reason === "unsupported"
              ? "relatorio_unsupported"
              : read.reason;
        return {
          status,
          body: {
            error,
            message: read.message,
            ...(read.filtrosDisponiveis ? { filtros_disponiveis: read.filtrosDisponiveis } : {}),
          },
        };
      }
      return {
        status: 200,
        body: { success: true, slug: slug!, salao_id: bridge?.salaoId ?? null, ...read.relatorio },
      };
    });

    res.status(result.status).json(result.body);
  } catch (err) {
    if (err instanceof CustomerInactiveError) {
      res.status(403).json({ error: "customer_inactive", message: err.message });
      return;
    }
    if (err instanceof NoSessionError) {
      res.status(401).json({ error: "not_logged_in", message: err.message });
      return;
    }
    if (err instanceof SessionBusyError) {
      res.status(409).json({ error: "session_busy", message: err.message });
      return;
    }
    logger.error({ slug, codigo, err: err instanceof Error ? err.message : String(err) }, "relatorio_failed");
    res.status(502).json({ error: "browser_error", message: "Falha ao consultar o relatorio no navegador" });
  }
});
