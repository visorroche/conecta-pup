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
import { type ClienteSearchType, createCliente, type NovoCliente, searchClientes } from "../services/clientes.js";
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

// ---------------------------------------------------------------------------
// POST /api/mid/avec/salao/{salao_id}/cliente
// ---------------------------------------------------------------------------

const text = (max: number) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .pipe(z.string().max(max, { message: `no maximo ${max} caracteres` }))
    .optional();

const digits = (label: string, sizes: number[]) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => String(v).replace(/\D/g, ""))
    .refine((v) => v === "" || sizes.includes(v.length), { message: `${label} invalido` })
    .optional();

/** aaaa-mm-dd ou dd/mm/aaaa -> dd/mm/aaaa (vazio = sem data) */
const birthDate = z
  .string()
  .trim()
  .transform((v, ctx) => {
    if (v === "") return "";
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v);
    const [d, m, y] = iso ? [iso[3]!, iso[2]!, iso[1]!] : br ? [br[1]!, br[2]!, br[3]!] : [];
    const date = d && m && y ? new Date(Date.UTC(Number(y), Number(m) - 1, Number(d))) : null;
    if (!date || date.getUTCDate() !== Number(d) || date.getUTCMonth() !== Number(m) - 1 || date > new Date()) {
      ctx.addIssue({ code: "custom", message: "datanasc invalida (use aaaa-mm-dd ou dd/mm/aaaa)" });
      return z.NEVER;
    }
    return `${d}/${m}/${y}`;
  })
  .optional();

const flag = z
  .union([z.boolean(), z.literal(0), z.literal(1), z.literal("0"), z.literal("1")])
  .transform((v) => v === true || v === 1 || v === "1")
  .optional();

const createSchema = z
  .object({
    nome: z
      .string({ error: "nome e obrigatorio" })
      .trim()
      .min(1, { message: "nome e obrigatorio" })
      .max(100, { message: "no maximo 100 caracteres" }),
    email: z.string().trim().max(100).email({ message: "email invalido" }).or(z.literal("")).optional(),
    datanasc: birthDate,
    celular: digits("celular", [10, 11]),
    telefone: digits("telefone", [10, 11]),
    operadora: z.enum(["Claro", "Nextel", "Oi", "Tim", "Vivo", "Porto Conecta", ""]).optional(),
    sexo: z.enum(["M", "F", "O", "P"]).optional(),
    cpf: digits("cpf", [11]),
    rg: text(30),
    profissao: text(60),
    como_conheceu: text(60),
    cep: digits("cep", [8]),
    estado: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^([A-Z]{2})?$/, { message: "estado deve ser a sigla (UF)" })
      .optional(),
    cidade: text(60),
    cod_cidade: text(10),
    bairro: text(29),
    endereco: text(100),
    numero: z.coerce.number().int().min(0).max(9_999_999).optional(),
    obs: text(2000),
    // existem na API antiga mas a plataforma nao grava; aceitos e ignorados
    apelido: z.unknown().optional(),
    complemento: z.unknown().optional(),
    email_mkt: flag,
    agendamento_online: flag,
    emissao_nota: flag,
    aceita_atendimento_ia: flag,
    aceita_comunicacao_whatsapp: flag,
  })
  .refine((v) => !(v.cidade || v.cod_cidade) || v.estado, {
    message: "informe o estado (UF) junto com a cidade",
    path: ["estado"],
  });

clientesRouter.post(`${BASE}/cliente`, callLogMiddleware, requireAuth, async (req, res) => {
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    invalidParams(res, parsed.error);
    return;
  }
  const { apelido: _a, complemento: _c, ...fields } = parsed.data;
  // so manda o que veio preenchido
  const cliente = Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v !== undefined && v !== ""),
  ) as unknown as NovoCliente;

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

      const created = await createCliente(page, { cliente, salaoId: salao.salaoId });
      await touchSession(slug!);

      if (!created.ok) {
        const status =
          created.reason === "session_expired"
            ? 401
            : created.reason === "timeout"
              ? 504
              : 422;
        const error = created.reason === "rejected" ? "cliente_rejected" : created.reason;
        return { ok: false, status, error, message: created.message };
      }
      return {
        ok: true,
        data: { ...(created.id !== undefined ? { id: created.id } : {}), ...(created.codigo !== undefined ? { codigo: created.codigo } : {}) },
      };
    });

    send(res, result);
  } catch (err) {
    handleCommonError(res, err, { slug }, "cliente_create_failed");
  }
});
