import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { noteCall } from "../services/call-log.js";
import { isLoggedIn, loginToAvec, readClientInfo } from "../services/avec-login.js";
import {
  BridgeProvisionError,
  CustomerInactiveError,
  ensureBridge,
  findBridge,
  findBridgeBySalaoId,
  saveClientInfo,
} from "../services/bridge.js";
import {
  destroySession,
  getPage,
  ProxyUnavailableError,
  saveStored,
  SessionBusyError,
  withSession,
} from "../services/session-manager.js";

export const authRouter: Router = Router();

const loginSchema = z
  .object({
    email: z.string().trim().email(),
    password: z.string().min(1),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "slug invalido")
      .optional(),
    salao_id: z.coerce.number().int().positive().optional(),
  })
  .refine((v) => v.slug !== undefined || v.salao_id !== undefined, {
    message: "informe slug ou salao_id",
    path: ["slug"],
  });

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid_params",
      message: "email, password e (slug ou salao_id) sao obrigatorios",
      details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
    return;
  }
  const { email, password, salao_id: salaoIdInput } = parsed.data;
  let slug = parsed.data.slug;

  try {
    // Somente salao_id: o slug vem da tabela customers_bridget.
    if (!slug) {
      const bySalao = await findBridgeBySalaoId(salaoIdInput!);
      if (!bySalao) {
        res.status(404).json({
          error: "salao_not_found",
          message: `Nenhum cliente com salao_id ${salaoIdInput} em customers_bridget. Informe o slug no primeiro acesso.`,
        });
        return;
      }
      slug = bySalao.slug;
    }

    // Cliente desativado (active=false) nao faz novos logins.
    const existing = await findBridge(slug);
    if (existing && !existing.active) throw new CustomerInactiveError(slug);

    // slug e salao_id informados juntos precisam bater com o cadastro.
    if (existing?.salaoId != null && salaoIdInput !== undefined && existing.salaoId !== salaoIdInput) {
      res.status(400).json({
        error: "slug_salao_mismatch",
        message: `O slug "${slug}" pertence ao salao_id ${existing.salaoId}, nao ao ${salaoIdInput}`,
      });
      return;
    }

    const result = await withSession(
      slug,
      async ({ browser, stored, reused }) => {
        const page = await getPage(browser, slug!, stored.sessionId);

        // Sessao reaproveitada e ainda logada com o mesmo usuario: continua dali.
        if (reused && stored.loggedIn && stored.email === email) {
          const state = await isLoggedIn(page, slug!);
          if (state.kind === "logged") {
            const client = await readClientInfo(page, state.salaoId);
            if (client) {
          noteCall({ salaoId: client.salaoId });
          await saveClientInfo(slug!, client);
        }
            stored.lastUsedAt = new Date().toISOString();
            await saveStored(stored);
            return { status: 200, body: payload(stored, true, client) };
          }
        }

        const login = await loginToAvec(page, { slug: slug!, email, password });
        if (!login.ok) {
          // Descarta a sessao (e o IP) para a proxima tentativa comecar limpa.
          await destroySession(slug!);
          return {
            status: login.reason === "invalid_credentials" ? 401 : 502,
            body: { error: login.reason, message: login.message },
          };
        }

        // O salao_id real vem do rodape da AVEC ("ID Cliente: N - NOME"); atualiza a tabela.
        const client = await readClientInfo(page, login.salaoId);
        if (client) {
          noteCall({ salaoId: client.salaoId });
          await saveClientInfo(slug!, client);
        }

        stored.loggedIn = true;
        stored.email = email;
        stored.lastUsedAt = new Date().toISOString();
        await saveStored(stored);
        return { status: 200, body: payload(stored, reused, client) };
      },
      {
        // outro usuario no mesmo slug: sessao nova (novo IP)
        shouldReset: (s) => s.loggedIn && s.email !== null && s.email !== email,
        // sem ponte na tabela customers_bridget: cria a zone na Bright Data e grava a linha
        resolveBridge: async () =>
          config.PROXY_ENABLED ? ensureBridge(slug!, email, salaoIdInput ?? null) : null,
      },
    );

    res.status(result.status).json(result.body);
  } catch (err) {
    if (err instanceof CustomerInactiveError) {
      res.status(403).json({ error: "customer_inactive", message: err.message });
      return;
    }
    if (err instanceof BridgeProvisionError) {
      logger.error({ slug, err: err.message }, "bridge_provision_failed");
      res.status(502).json({
        error: "bridge_unavailable",
        message: "Nao foi possivel criar a ponte (IP) deste cliente na Bright Data",
      });
      return;
    }
    if (err instanceof SessionBusyError) {
      res.status(409).json({ error: "session_busy", message: err.message });
      return;
    }
    if (err instanceof ProxyUnavailableError) {
      res.status(502).json({ error: "proxy_unavailable", message: err.message });
      return;
    }
    logger.error({ slug, err: err instanceof Error ? err.message : String(err) }, "login_failed");
    if (slug) await destroySession(slug).catch(() => undefined);
    res.status(502).json({
      error: "browser_error",
      message: "Falha ao executar o login no navegador",
    });
  }
});

function payload(
  stored: {
    slug: string;
    sessionId: string;
    proxyIp: string | null;
    proxyCountry?: string | null;
  },
  reused: boolean,
  client: { salaoId: number; name: string | null } | null,
) {
  return {
    success: true,
    slug: stored.slug,
    salao_id: client?.salaoId ?? null,
    nome: client?.name ?? null,
    sessionId: stored.sessionId,
    reused,
    proxyIp: stored.proxyIp,
    proxyCountry: stored.proxyCountry ?? null,
  };
}
