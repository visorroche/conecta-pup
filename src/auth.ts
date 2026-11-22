import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { errors as joseErrors, jwtVerify, SignJWT } from "jose";
import { config } from "./config.js";
import { fail, type Outcome } from "./http.js";

/** Dados do usuario autenticado, extraidos do token. */
export interface AuthUser {
  salaoId: number;
  slug: string;
  email: string;
  /** id da sessao que existia quando o token foi emitido */
  sid: string;
}

const secret = new TextEncoder().encode(config.JWT_SECRET);

/** Gera o token do login (formato da API antiga: bearer, expires_in em segundos). */
export async function signToken(user: AuthUser): Promise<{ access_token: string; token_type: "bearer"; expires_in: number }> {
  const access_token = await new SignJWT({ slug: user.slug, email: user.email, sid: user.sid })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(String(user.salaoId))
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${config.JWT_TTL_SECONDS}s`)
    .sign(secret);
  return { access_token, token_type: "bearer", expires_in: config.JWT_TTL_SECONDS };
}

export function getAuth(res: Response): AuthUser {
  return res.locals.auth as AuthUser;
}

/**
 * Exige `Authorization: Bearer <token>`. Se a rota tem `:salao_id`, o token precisa ser desse salao.
 * Deve vir depois do callLogMiddleware (para registrar os 401/403 no log).
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) {
    res.setHeader("WWW-Authenticate", "Bearer");
    fail(res, 401, "Token nao informado", "token_missing");
    return;
  }

  let user: AuthUser;
  try {
    const { payload } = await jwtVerify(match[1]!.trim(), secret, { algorithms: ["HS256"] });
    const salaoId = Number(payload.sub);
    if (!Number.isInteger(salaoId) || typeof payload.slug !== "string" || typeof payload.sid !== "string") {
      throw new Error("claims invalidos");
    }
    user = { salaoId, slug: payload.slug, email: String(payload.email ?? ""), sid: payload.sid };
  } catch (err) {
    res.setHeader("WWW-Authenticate", "Bearer");
    const expired = err instanceof joseErrors.JWTExpired;
    fail(res, 401, expired ? "Token expirado" : "Token invalido", expired ? "token_expired" : "token_invalid");
    return;
  }

  const pathSalao = req.params.salao_id;
  if (pathSalao !== undefined && Number(pathSalao) !== user.salaoId) {
    fail(res, 403, "Token nao pertence a este salao", "token_salao_mismatch");
    return;
  }

  res.locals.auth = user;
  next();
}

/** O token so vale para a sessao que ele foi emitido; outro login no mesmo salao invalida os antigos. */
export function tokenSessionMismatch(auth: AuthUser, storedSessionId: string): Outcome | null {
  if (auth.sid === storedSessionId) return null;
  return {
    ok: false,
    status: 401,
    error: "token_stale",
    message: "Token nao corresponde a sessao atual. Faca login novamente em POST /api/auth/login.",
  };
}
