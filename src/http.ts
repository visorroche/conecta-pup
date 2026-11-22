import type { Response } from "express";
import { z } from "zod";
import { logger } from "./logger.js";
import { BridgeProvisionError, CustomerInactiveError, findBridgeBySalaoId, type Bridge } from "./services/bridge.js";
import {
  NoSessionError,
  ProxyUnavailableError,
  SessionBusyError,
} from "./services/session-manager.js";

/**
 * Formato de resposta no padrao da API antiga (proxy "Mid"):
 *   sucesso: { code: 200, data: {...} }
 *   erro:    { code: 404, message: "...", file: null, line: null, trace: null }
 */

/** Tira da mensagem qualquer detalhe de como o acesso e feito. */
export function publicMessage(message: string): string {
  let out = message
    .replace(/\s*O IP da sessao pode ter sido barrado\./gi, "")
    .replace(/painel Metabase( \(iframe\))?/gi, "painel")
    .replace(/\bnavegador\b/gi, "servico")
    .replace(/\bAVEC\b/g, "plataforma");
  if (out.startsWith("plataforma")) out = "A " + out;
  return out;
}

export function ok(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ code: status, data });
}

export function fail(
  res: Response,
  status: number,
  message: string,
  errorCode?: string,
  extra?: Record<string, unknown>,
): void {
  // O codigo interno nao vai no corpo; fica so no log (api_call_log.error_code).
  res.locals.errorCode = errorCode ?? null;
  res.status(status).json({
    code: status,
    message: publicMessage(message),
    file: null,
    line: null,
    trace: null,
    ...extra,
  });
}

/** Resultado de uma operacao dentro de withSession/withExistingSession. */
export type Outcome =
  | { ok: true; status?: number; data: unknown }
  | { ok: false; status: number; error: string; message: string; extra?: Record<string, unknown> };

export function send(res: Response, outcome: Outcome): void {
  if (outcome.ok) ok(res, outcome.data, outcome.status ?? 200);
  else fail(res, outcome.status, outcome.message, outcome.error, outcome.extra);
}

export function invalidParams(res: Response, error: z.ZodError, message = "Parametros invalidos"): void {
  fail(res, 400, message, "invalid_params", {
    errors: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  });
}

export const sessionExpired: Outcome = {
  ok: false,
  status: 401,
  error: "session_expired",
  message: "A sessao expirou. Faca login novamente em POST /api/auth/login.",
};

const salaoIdSchema = z.coerce.number().int().positive();

/**
 * Resolve o salao da URL (`/salao/:salao_id`) para o cadastro interno.
 * Responde 400/404/403 sozinha e devolve null quando nao da para seguir.
 */
export async function resolveSalao(
  res: Response,
  salaoIdParam: unknown,
): Promise<{ salaoId: number; slug: string; bridge: Bridge } | null> {
  const parsed = salaoIdSchema.safeParse(salaoIdParam);
  if (!parsed.success) {
    fail(res, 400, "salao_id invalido", "invalid_params");
    return null;
  }
  const bridge = await findBridgeBySalaoId(parsed.data);
  if (!bridge) {
    fail(res, 404, `Salao ${parsed.data} nao encontrado`, "salao_not_found");
    return null;
  }
  if (!bridge.active) throw new CustomerInactiveError(bridge.slug);
  return { salaoId: parsed.data, slug: bridge.slug, bridge };
}

/** Responde aos erros comuns das operacoes com sessao. Retorna false se o erro foi inesperado. */
export function handleCommonError(res: Response, err: unknown, ctx: Record<string, unknown>, what: string): boolean {
  if (err instanceof CustomerInactiveError) {
    fail(res, 403, "Cliente desativado", "customer_inactive");
    return true;
  }
  if (err instanceof BridgeProvisionError) {
    logger.error({ ...ctx, err: err.message }, "bridge_provision_failed");
    fail(res, 502, "Servico temporariamente indisponivel", "bridge_unavailable");
    return true;
  }
  if (err instanceof NoSessionError) {
    fail(res, 401, "Sessao nao encontrada. Faca login em POST /api/auth/login primeiro.", "not_logged_in");
    return true;
  }
  if (err instanceof SessionBusyError) {
    fail(res, 409, "Ja existe uma operacao em andamento para este salao", "session_busy");
    return true;
  }
  if (err instanceof ProxyUnavailableError) {
    logger.error({ ...ctx, err: err.message }, "proxy_unavailable");
    fail(res, 502, "Servico temporariamente indisponivel", "proxy_unavailable");
    return true;
  }
  logger.error({ ...ctx, err: err instanceof Error ? err.message : String(err) }, what);
  fail(res, 502, "Falha ao executar a operacao", "browser_error");
  return false;
}
