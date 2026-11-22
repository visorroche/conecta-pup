import { Router } from "express";
import { z } from "zod";
import { getAuth, requireAuth, signToken } from "../auth.js";
import { config } from "../config.js";
import { fail, handleCommonError, invalidParams, ok } from "../http.js";
import { noteCall, callLogMiddleware } from "../services/call-log.js";
import { isLoggedIn, loginToAvec, readClientInfo } from "../services/avec-login.js";
import {
  CustomerInactiveError,
  ensureBridge,
  findBridge,
  findBridgeBySalaoId,
  saveClientInfo,
} from "../services/bridge.js";
import { destroySession, getPage, saveStored, withSession } from "../services/session-manager.js";

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

/** POST /api/auth/login */
authRouter.post("/auth/login", callLogMiddleware, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    invalidParams(res, parsed.error, "email, password e (slug ou salao_id) sao obrigatorios");
    return;
  }
  const { email, password, salao_id: salaoIdInput } = parsed.data;
  let slug = parsed.data.slug;

  try {
    // Somente salao_id: o slug vem do cadastro.
    if (!slug) {
      const bySalao = await findBridgeBySalaoId(salaoIdInput!);
      if (!bySalao) {
        fail(res, 404, `Salao ${salaoIdInput} nao encontrado. Informe o slug no primeiro acesso.`, "salao_not_found");
        return;
      }
      slug = bySalao.slug;
    }

    // Cliente desativado (active=false) nao faz novos logins.
    const existing = await findBridge(slug);
    if (existing && !existing.active) throw new CustomerInactiveError(slug);

    // slug e salao_id informados juntos precisam bater com o cadastro.
    if (existing?.salaoId != null && salaoIdInput !== undefined && existing.salaoId !== salaoIdInput) {
      fail(res, 400, "slug e salao_id nao pertencem ao mesmo cliente", "slug_salao_mismatch");
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
            return { ok: true as const, sid: stored.sessionId, client, reused: true };
          }
        }

        const login = await loginToAvec(page, { slug: slug!, email, password });
        if (!login.ok) {
          // Descarta a sessao (e o IP) para a proxima tentativa comecar limpa.
          await destroySession(slug!);
          return {
            ok: false as const,
            status: login.reason === "invalid_credentials" ? 401 : 502,
            error: login.reason,
            message: login.message,
          };
        }

        // O salao_id real vem do rodape da plataforma ("ID Cliente: N - NOME"); atualiza o cadastro.
        const client = await readClientInfo(page, login.salaoId);
        if (client) {
          noteCall({ salaoId: client.salaoId });
          await saveClientInfo(slug!, client);
        }

        stored.loggedIn = true;
        stored.email = email;
        stored.lastUsedAt = new Date().toISOString();
        await saveStored(stored);
        return { ok: true as const, sid: stored.sessionId, client, reused };
      },
      {
        // outro usuario no mesmo slug: sessao nova
        shouldReset: (s) => s.loggedIn && s.email !== null && s.email !== email,
        // sem cadastro: provisiona o acesso do cliente e grava a linha
        resolveBridge: async () =>
          config.PROXY_ENABLED ? ensureBridge(slug!, email, salaoIdInput ?? null) : null,
      },
    );

    if (!result.ok) {
      fail(res, result.status, result.message, result.error);
      return;
    }

    // salao_id: rodape da plataforma > cadastro > o que veio no body
    const saved = await findBridge(slug);
    const salaoId = result.client?.salaoId ?? saved?.salaoId ?? salaoIdInput ?? null;
    if (salaoId === null) {
      fail(res, 502, "Nao foi possivel identificar o salao", "salao_unknown");
      return;
    }
    const nome = result.client?.name ?? saved?.nome ?? null;
    const token = await signToken({ salaoId, slug, email, sid: result.sid });
    ok(res, {
      ...token,
      user: { salao_id: salaoId, slug, nome, email },
      reused: result.reused,
    });
  } catch (err) {
    // falha inesperada: descarta a sessao para a proxima tentativa comecar limpa
    const known = handleCommonError(res, err, { slug }, "login_failed");
    if (!known && slug) await destroySession(slug).catch(() => undefined);
  }
});

/** GET /api/auth/user-profile (exige token) */
authRouter.get("/auth/user-profile", callLogMiddleware, requireAuth, async (_req, res) => {
  const auth = getAuth(res);
  const saved = await findBridge(auth.slug).catch(() => null);
  ok(res, {
    user: { salao_id: auth.salaoId, slug: auth.slug, nome: saved?.nome ?? null, email: auth.email },
  });
});
