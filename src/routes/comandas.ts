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
import { readComanda } from "../services/comanda-read.js";
import { normalizeDate, openComanda, pickSearchField } from "../services/comandas.js";
import {
  destroySession,
  getPage,
  touchSession,
  withExistingSession,
} from "../services/session-manager.js";

export const comandasRouter: Router = Router();

const BASE = "/mid/avec/salao/:salao_id";

const optionalText = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .optional()
  .transform((v) => (v ? v : undefined));

// ---------------------------------------------------------------------------
// POST /api/mid/avec/salao/{salao_id}/comandas
// ---------------------------------------------------------------------------

const createSchema = z
  .object({
    numero: optionalText.refine((v) => v === undefined || /^\d{1,10}$/.test(v), {
      message: "numero deve conter apenas digitos",
    }),
    data: optionalText,
    // identificacao do cliente: campos diretos ...
    cpf: optionalText,
    celular: optionalText,
    phone: optionalText, // apelido de celular
    codigo: optionalText,
    email: optionalText,
    // ... ou no formato da busca de cliente da API antiga: chave=celular&valor=...
    chave: z.enum(["celular", "telefone", "cpf", "email", "codigo"]).optional(),
    valor: optionalText,
  })
  .refine((v) => v.codigo || v.cpf || v.celular || v.phone || v.email || (v.chave && v.valor), {
    message: "informe codigo, cpf, celular ou email do cliente (ou chave e valor)",
    path: ["codigo"],
  });

comandasRouter.post(`${BASE}/comandas`, callLogMiddleware, requireAuth, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    invalidParams(res, parsed.error);
    return;
  }
  const body = parsed.data;

  const data = normalizeDate(body.data);
  if (!data) {
    fail(res, 400, "data invalida (use aaaa-mm-dd ou dd/mm/aaaa)", "invalid_params");
    return;
  }

  // chave/valor -> campo direto
  const fields = {
    codigo: body.codigo,
    cpf: body.cpf,
    phone: body.celular ?? body.phone,
    email: body.email,
  };
  if (body.chave && body.valor) {
    if (body.chave === "celular" || body.chave === "telefone") fields.phone ??= body.valor;
    else fields[body.chave] ??= body.valor;
  }
  // Se vierem varios, vale a ordem: codigo, cpf, celular, email
  const search = pickSearchField(fields);
  if (!search || !search.value) {
    fail(res, 400, "Campo de busca vazio", "invalid_params");
    return;
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

      const opened = await openComanda(page, {
        type: search.type,
        value: search.value,
        data,
        numero: body.numero,
      });
      await touchSession(slug!);

      if (!opened.ok) {
        const status =
          opened.reason === "client_not_found"
            ? 404
            : opened.reason === "already_open"
              ? 409
              : opened.reason === "session_expired"
                ? 401
                : opened.reason === "timeout"
                  ? 504
                  : 422;
        return {
          ok: false,
          status,
          error: opened.reason,
          message: opened.message.replace(/ por phone /, " por celular "),
        };
      }
      return {
        ok: true,
        data: {
          comanda: {
            id: opened.avecComandaId,
            numero: opened.numero,
            data: opened.data,
            cliente: opened.clienteNome,
            busca: { campo: search.type === "phone" ? "celular" : search.type, valor: search.value },
          },
        },
      };
    });

    send(res, result);
  } catch (err) {
    handleCommonError(res, err, { slug }, "comanda_failed");
  }
});

// ---------------------------------------------------------------------------
// GET /api/mid/avec/salao/{salao_id}/comanda/{numero}?data=
// ---------------------------------------------------------------------------

const getSchema = z.object({
  numero: z.coerce.number().int().positive().max(9_999_999_999),
  data: z.string().trim().optional(),
});

comandasRouter.get(`${BASE}/comanda/:numero`, callLogMiddleware, requireAuth, async (req, res) => {
  const parsed = getSchema.safeParse({ numero: req.params.numero, data: req.query.data });
  if (!parsed.success) {
    invalidParams(res, parsed.error);
    return;
  }
  const query = parsed.data;
  const data = normalizeDate(query.data);
  if (!data) {
    fail(res, 400, "data invalida (use aaaa-mm-dd ou dd/mm/aaaa)", "invalid_params");
    return;
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

      const read = await readComanda(page, { numero: query.numero, data });
      await touchSession(slug!);

      if (!read.ok) {
        const status = read.reason === "not_found" ? 404 : read.reason === "session_expired" ? 401 : 504;
        const error = read.reason === "not_found" ? "comanda_not_found" : read.reason;
        return { ok: false, status, error, message: read.message };
      }
      const { itens, pagamentos, ...comanda } = read.comanda;
      return { ok: true, data: { comanda, itens, pagamentos } };
    });

    send(res, result);
  } catch (err) {
    handleCommonError(res, err, { slug }, "comanda_read_failed");
  }
});
