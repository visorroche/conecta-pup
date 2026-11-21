import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { HTTPRequest, HTTPResponse, Page } from "puppeteer";
import { pool } from "../db.js";
import { logger } from "../logger.js";

/** Contexto de uma chamada a esta API (propagado via AsyncLocalStorage). */
export interface CallContext {
  callId: string;
  startedAt: number;
  slug: string | null;
  salaoId: number | null;
  sessionId: string | null;
  proxyIp: string | null;
  proxyCountry: string | null;
  zone: string | null;
  reused: boolean | null;
  errorCode: string | null;
  avecRequests: number;
  avecErrors: number;
  avecBlocks: number;
}

const als = new AsyncLocalStorage<CallContext>();

/** Chamada em andamento por slug (so ha uma por vez: o lock do slug garante). */
const activeCalls = new Map<string, CallContext>();
/** Ultima chamada encerrada por slug: respostas tardias (XHR apos o fim da rota) herdam dela. */
const lastCalls = new Map<string, CallContext>();

export function currentCall(): CallContext | undefined {
  return als.getStore();
}

/** Atualiza campos do contexto da chamada atual (sessao, IP, zona, salao...). */
export function noteCall(patch: Partial<Omit<CallContext, "callId" | "startedAt">>): void {
  const ctx = als.getStore();
  if (ctx) Object.assign(ctx, patch);
}

/** Associa a chamada atual ao slug para que as respostas da AVEC sejam gravadas nela. */
export function bindCall(slug: string): void {
  const ctx = als.getStore();
  if (!ctx) return;
  ctx.slug = slug;
  activeCalls.set(slug, ctx);
}

export function releaseCall(slug: string): void {
  const ctx = als.getStore();
  if (ctx && activeCalls.get(slug) === ctx) {
    activeCalls.delete(slug);
    lastCalls.set(slug, ctx);
  }
}

/** Middleware: grava uma linha em api_call_log ao terminar cada chamada. */
export function callLogMiddleware(req: Request, res: Response, next: NextFunction): void {
  const ctx: CallContext = {
    callId: randomUUID(),
    startedAt: Date.now(),
    slug: null,
    salaoId: null,
    sessionId: null,
    proxyIp: null,
    proxyCountry: null,
    zone: null,
    reused: null,
    errorCode: null,
    avecRequests: 0,
    avecErrors: 0,
    avecBlocks: 0,
  };

  const originalJson = res.json.bind(res);
  res.json = (body?: unknown) => {
    const err = (body as { error?: unknown } | null | undefined)?.error;
    if (typeof err === "string") ctx.errorCode = err;
    return originalJson(body);
  };

  res.on("finish", () => {
    const routePath = req.route?.path === "/" ? "" : String(req.route?.path ?? "");
    const route = `${req.method} ${req.baseUrl}${routePath}`.slice(0, 64);
    void pool
      .query(
        `INSERT INTO api_call_log
           (call_id, route, slug, salao_id, http_status, error_code, duration_ms,
            session_id, session_reused, proxy_ip, proxy_country, brd_zone,
            avec_requests, avec_errors, avec_blocks)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          ctx.callId,
          route,
          ctx.slug,
          ctx.salaoId,
          res.statusCode,
          ctx.errorCode,
          Date.now() - ctx.startedAt,
          ctx.sessionId,
          ctx.reused === null ? null : ctx.reused ? 1 : 0,
          ctx.proxyIp,
          ctx.proxyCountry,
          ctx.zone,
          ctx.avecRequests,
          ctx.avecErrors,
          ctx.avecBlocks,
        ],
      )
      .catch((e: unknown) =>
        logger.warn({ err: e instanceof Error ? e.message : String(e) }, "api_call_log_failed"),
      );
  });

  als.run(ctx, next);
}

// ---------------------------------------------------------------------------
// Respostas HTTP da AVEC observadas pelo Puppeteer
// ---------------------------------------------------------------------------

const LOGGED_TYPES = new Set(["document", "xhr", "fetch"]);
const WAF_SERVER = /awselb|cloudflare|cloudfront|akamai|imperva|incapsula|sucuri|datadome|perimeterx/i;
const KEEP_HEADERS = [
  "server",
  "via",
  "x-cache",
  "x-amzn-requestid",
  "x-amz-cf-id",
  "cf-ray",
  "retry-after",
  "content-type",
  "location",
  "x-ratelimit-remaining",
];

function isAvecHost(host: string): boolean {
  return host.endsWith("avec.beauty") || host.includes("cognito-idp.") || host.endsWith("amazoncognito.com");
}

function isBlock(status: number | null, server: string): boolean {
  if (status === null) return false;
  if (status === 403 || status === 429) return true;
  return status >= 400 && WAF_SERVER.test(server);
}

const attached = new WeakSet<Page>();

/** Liga o registro das respostas da AVEC nesta aba (idempotente). */
export function attachAvecLogger(page: Page, slug: string): void {
  if (attached.has(page)) return;
  attached.add(page);

  const started = new WeakMap<HTTPRequest, number>();

  page.on("request", (req) => {
    started.set(req, Date.now());
  });

  const record = (row: {
    req: HTTPRequest;
    status: number | null;
    errorText: string | null;
    headers: Record<string, string>;
    snippet: string | null;
  }) => {
    const ctx = activeCalls.get(slug) ?? lastCalls.get(slug);
    const url = new URL(row.req.url());
    const server = row.headers["server"] ?? "";
    const block = isBlock(row.status, server) || (row.errorText !== null && /PROXY|TUNNEL/i.test(row.errorText));
    if (ctx) {
      ctx.avecRequests += 1;
      if ((row.status ?? 0) >= 400 || row.errorText) ctx.avecErrors += 1;
      if (block) ctx.avecBlocks += 1;
    }
    const kept: Record<string, string> = {};
    for (const key of KEEP_HEADERS) if (row.headers[key]) kept[key] = row.headers[key].slice(0, 200);

    void pool
      .query(
        `INSERT INTO avec_response_log
           (call_id, slug, salao_id, route_hint, brd_zone, proxy_ip, proxy_country, session_id,
            method, host, path, resource_type, status, error_text, is_block,
            server, headers, body_snippet, latency_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          ctx?.callId ?? null,
          slug,
          ctx?.salaoId ?? null,
          null,
          ctx?.zone ?? null,
          ctx?.proxyIp ?? null,
          ctx?.proxyCountry ?? null,
          ctx?.sessionId ?? null,
          row.req.method().slice(0, 8),
          url.host.slice(0, 128),
          url.pathname.slice(0, 255),
          row.req.resourceType().slice(0, 16),
          row.status,
          row.errorText ? row.errorText.slice(0, 128) : null,
          block ? 1 : 0,
          server.slice(0, 64) || null,
          Object.keys(kept).length ? JSON.stringify(kept) : null,
          row.snippet,
          Date.now() - (started.get(row.req) ?? Date.now()),
        ],
      )
      .catch((e: unknown) =>
        logger.warn({ err: e instanceof Error ? e.message : String(e) }, "avec_response_log_failed"),
      );
  };

  page.on("response", (res: HTTPResponse) => {
    const req = res.request();
    let host: string;
    try {
      host = new URL(req.url()).host;
    } catch {
      return;
    }
    if (!isAvecHost(host) || !LOGGED_TYPES.has(req.resourceType())) return;

    void (async () => {
      let snippet: string | null = null;
      const status = res.status();
      if (status >= 400) {
        try {
          const text = await res.text();
          snippet = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400) || null;
        } catch {
          /* corpo indisponivel */
        }
      }
      record({ req, status, errorText: null, headers: res.headers(), snippet });
    })();
  });

  page.on("requestfailed", (req) => {
    let host: string;
    try {
      host = new URL(req.url()).host;
    } catch {
      return;
    }
    if (!isAvecHost(host) || !LOGGED_TYPES.has(req.resourceType())) return;
    const failure = req.failure()?.errorText ?? "unknown";
    // abortos normais de navegacao (ex.: troca de pagina) nao interessam
    if (/ERR_ABORTED/.test(failure)) return;
    record({ req, status: null, errorText: failure, headers: {}, snippet: null });
  });
}
