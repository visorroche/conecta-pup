import { Router } from "express";
import { z } from "zod";
import { logger } from "../logger.js";
import { isLoggedIn } from "../services/avec-login.js";
import { CustomerInactiveError, findBridge, findBridgeBySalaoId } from "../services/bridge.js";
import { readComanda } from "../services/comanda-read.js";
import {
  normalizeDate,
  openComanda,
  pickSearchField,
} from "../services/comandas.js";
import {
  destroySession,
  getPage,
  NoSessionError,
  SessionBusyError,
  touchSession,
  withExistingSession,
} from "../services/session-manager.js";

export const comandasRouter: Router = Router();

const optionalText = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .optional()
  .transform((v) => (v ? v : undefined));

const schema = z
  .object({
    // Identifica o cliente AVEC (a sessao aberta no login): slug e/ou salao_id
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "slug invalido")
      .optional(),
    salao_id: z.coerce.number().int().positive().optional(),

    numero: optionalText.refine((v) => v === undefined || /^\d{1,10}$/.test(v), {
      message: "numero deve conter apenas digitos",
    }),
    data: optionalText,
    cpf: optionalText,
    phone: optionalText,
    codigo: optionalText,
    email: optionalText,
  })
  .refine((v) => v.slug !== undefined || v.salao_id !== undefined, {
    message: "informe slug ou salao_id",
    path: ["slug"],
  })
  .refine((v) => v.codigo || v.cpf || v.phone || v.email, {
    message: "informe codigo, cpf, phone ou email do cliente",
    path: ["codigo"],
  });

comandasRouter.post("/", async (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid_params",
      message: "Parametros invalidos",
      details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
    return;
  }
  const body = parsed.data;

  const data = normalizeDate(body.data);
  if (!data) {
    res.status(400).json({
      error: "invalid_params",
      message: "data invalida (use aaaa-mm-dd ou dd/mm/aaaa)",
    });
    return;
  }
  // Se vierem varios, vale a ordem: codigo, cpf, phone, email
  const search = pickSearchField(body);
  if (!search || !search.value) {
    res.status(400).json({ error: "invalid_params", message: "Campo de busca vazio" });
    return;
  }

  let slug = body.slug;
  try {
    if (!slug) {
      const bySalao = await findBridgeBySalaoId(body.salao_id!);
      if (!bySalao) {
        res.status(404).json({
          error: "salao_not_found",
          message: `Nenhum cliente com salao_id ${body.salao_id} em customers_bridget`,
        });
        return;
      }
      slug = bySalao.slug;
    }

    const bridge = await findBridge(slug);
    if (bridge && !bridge.active) throw new CustomerInactiveError(slug);
    if (bridge?.salaoId != null && body.salao_id !== undefined && bridge.salaoId !== body.salao_id) {
      res.status(400).json({
        error: "slug_salao_mismatch",
        message: `O slug "${slug}" pertence ao salao_id ${bridge.salaoId}, nao ao ${body.salao_id}`,
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
        return { status, body: { error: opened.reason, message: opened.message } };
      }
      return {
        status: 201,
        body: {
          success: true,
          slug: slug!,
          salao_id: bridge?.salaoId ?? null,
          comanda: {
            numero: opened.numero,
            data: opened.data,
            cliente: opened.clienteNome,
            busca: { campo: search.type, valor: search.value },
            avec_id: opened.avecComandaId,
          },
        },
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
    logger.error({ slug, err: err instanceof Error ? err.message : String(err) }, "comanda_failed");
    res.status(502).json({
      error: "browser_error",
      message: "Falha ao abrir a comanda no navegador",
    });
  }
});

// ---------------------------------------------------------------------------
// GET /comandas?slug=...&data=...&numero=...
// ---------------------------------------------------------------------------

const getSchema = z
  .object({
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "slug invalido")
      .optional(),
    salao_id: z.coerce.number().int().positive().optional(),
    numero: z.coerce.number().int().positive().max(9_999_999_999),
    data: z.string().trim().optional(),
  })
  .refine((v) => v.slug !== undefined || v.salao_id !== undefined, {
    message: "informe slug ou salao_id",
    path: ["slug"],
  });

comandasRouter.get("/", async (req, res) => {
  const parsed = getSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid_params",
      message: "Parametros invalidos",
      details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
    return;
  }
  const query = parsed.data;
  const data = normalizeDate(query.data);
  if (!data) {
    res.status(400).json({
      error: "invalid_params",
      message: "data invalida (use aaaa-mm-dd ou dd/mm/aaaa)",
    });
    return;
  }

  let slug = query.slug;
  try {
    if (!slug) {
      const bySalao = await findBridgeBySalaoId(query.salao_id!);
      if (!bySalao) {
        res.status(404).json({
          error: "salao_not_found",
          message: `Nenhum cliente com salao_id ${query.salao_id} em customers_bridget`,
        });
        return;
      }
      slug = bySalao.slug;
    }
    const bridge = await findBridge(slug);
    if (bridge && !bridge.active) throw new CustomerInactiveError(slug);
    if (bridge?.salaoId != null && query.salao_id !== undefined && bridge.salaoId !== query.salao_id) {
      res.status(400).json({
        error: "slug_salao_mismatch",
        message: `O slug "${slug}" pertence ao salao_id ${bridge.salaoId}, nao ao ${query.salao_id}`,
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

      const read = await readComanda(page, { numero: query.numero, data });
      await touchSession(slug!);

      if (!read.ok) {
        const status = read.reason === "not_found" ? 404 : read.reason === "session_expired" ? 401 : 504;
        const error = read.reason === "not_found" ? "comanda_not_found" : read.reason;
        return { status, body: { error, message: read.message } };
      }
      const { itens, pagamentos, ...comanda } = read.comanda;
      return {
        status: 200,
        body: {
          success: true,
          slug: slug!,
          salao_id: bridge?.salaoId ?? null,
          comanda,
          itens,
          pagamentos,
        },
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
    logger.error({ slug, err: err instanceof Error ? err.message : String(err) }, "comanda_read_failed");
    res.status(502).json({
      error: "browser_error",
      message: "Falha ao consultar a comanda no navegador",
    });
  }
});
