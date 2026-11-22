import { Router } from "express";
import { z } from "zod";
import { getAuth, requireAuth, tokenSessionMismatch } from "../auth.js";
import {
  fail,
  handleCommonError,
  invalidParams,
  type Outcome,
  resolveSalao,
  send,
  sessionExpired,
} from "../http.js";
import { isLoggedIn } from "../services/avec-login.js";
import { callLogMiddleware } from "../services/call-log.js";
import { readRelatorio } from "../services/relatorio.js";
import {
  destroySession,
  getPage,
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

/**
 * GET /api/mid/avec/salao/{salao_id}/relatorio/{codigo}?<filtros do relatorio>
 * Todo query param e repassado como filtro (name do input na tela). Datas aceitam
 * aaaa-mm-dd ou dd/mm/aaaa (como `inicio`/`fim` da API antiga).
 */
relatoriosRouter.get("/mid/avec/salao/:salao_id/relatorio/:codigo", callLogMiddleware, requireAuth, async (req, res) => {
  const params = paramsSchema.safeParse({ codigo: req.params.codigo });
  if (!params.success) {
    invalidParams(res, params.error);
    return;
  }
  const codigo = params.data.codigo;

  const filtros: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value !== "string") {
      fail(res, 400, `filtro "${key}" deve ser um unico valor`, "invalid_params");
      return;
    }
    filtros[key] = value;
  }

  let slug: string | undefined;
  try {
    const salao = await resolveSalao(res, req.params.salao_id);
    if (!salao) return;
    slug = salao.slug;

    const result = await withExistingSession<Outcome>(slug, async ({ browser, stored }) => {
      const stale = tokenSessionMismatch(getAuth(res), stored.sessionId);
      if (stale) return stale;
      const page = await getPage(browser, slug!, stored.sessionId);
      const state = await isLoggedIn(page, slug!);
      if (state.kind !== "logged") {
        await destroySession(slug!);
        return sessionExpired;
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
          ok: false,
          status,
          error,
          message: read.message,
          ...(read.filtrosDisponiveis ? { extra: { filtros_disponiveis: read.filtrosDisponiveis } } : {}),
        };
      }
      return { ok: true, data: read.relatorio };
    });

    send(res, result);
  } catch (err) {
    handleCommonError(res, err, { slug, codigo }, "relatorio_failed");
  }
});
