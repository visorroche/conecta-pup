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
import { type ClienteSearchType, searchClientes } from "../services/clientes.js";
import {
  destroySession,
  getPage,
  touchSession,
  withExistingSession,
} from "../services/session-manager.js";

export const clientesRouter: Router = Router();

const BASE = "/mid/avec/salao/:salao_id";

const querySchema = z.object({
  chave: z.enum(["celular", "telefone", "cpf", "email", "codigo", "nome"]),
  valor: z
    .union([z.string(), z.number()], { error: "valor e obrigatorio" })
    .transform((v) => String(v).trim())
    .refine((v) => v.length > 0, { message: "valor nao pode ser vazio" }),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

/**
 * GET /api/mid/avec/salao/{salao_id}/cliente?chave=celular&valor=11999999999
 * chave: celular | telefone | cpf | email | codigo | nome
 * Resposta no formato da API antiga: data.salonClient[].
 */
clientesRouter.get(`${BASE}/cliente`, callLogMiddleware, requireAuth, async (req, res) => {
  const parsed = querySchema.safeParse({
    chave: req.query.chave,
    valor: req.query.valor,
    limit: req.query.limit,
  });
  if (!parsed.success) {
    invalidParams(res, parsed.error);
    return;
  }
  const query = parsed.data;
  const type: ClienteSearchType = query.chave === "telefone" ? "celular" : query.chave;

  let value = query.valor;
  if (type === "celular" || type === "cpf" || type === "codigo") {
    value = value.replace(/\D/g, "");
    if (!value) {
      fail(res, 400, `valor invalido para ${query.chave}`, "invalid_params");
      return;
    }
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

      const found = await searchClientes(page, {
        type,
        value,
        limit: query.limit,
        salaoId: salao.salaoId,
      });
      await touchSession(slug!);

      if (!found.ok) {
        return {
          ok: false,
          status: found.reason === "session_expired" ? 401 : 504,
          error: found.reason,
          message: found.message,
        };
      }
      return { ok: true, data: { salonClient: found.clientes, total: found.total } };
    });

    send(res, result);
  } catch (err) {
    handleCommonError(res, err, { slug }, "cliente_search_failed");
  }
});
