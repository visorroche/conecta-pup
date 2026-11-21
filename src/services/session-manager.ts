import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { redis } from "../redis.js";
import { type Bridge, getBridgeCached } from "./bridge.js";
import { attachAvecLogger, bindCall, noteCall, releaseCall } from "./call-log.js";
import { BRD_COUNTRY, buildProxySettings, fetchExitIp, newProxySessionId } from "./proxy.js";

async function bridgeNote(slug: string): Promise<{ zone: string | null; salaoId: number | null }> {
  const bridge = await getBridgeCached(slug).catch(() => null);
  return { zone: bridge?.brdZone ?? null, salaoId: bridge?.salaoId ?? null };
}

/** Dados persistidos no Redis por slug. Nunca guardar senha aqui. */
export interface StoredSession {
  slug: string;
  sessionId: string;
  wsEndpoint: string;
  proxyIp: string | null;
  /** pais (ISO alpha-2, maiusculo) do IP de saida, lido na criacao da sessao */
  proxyCountry?: string | null;
  email: string | null;
  loggedIn: boolean;
  createdAt: string;
  lastUsedAt: string;
}

export interface SessionHandle {
  browser: Browser;
  stored: StoredSession;
  /** true quando o Chromium ja existia (sessao reaproveitada) */
  reused: boolean;
}

export class SessionBusyError extends Error {
  constructor(slug: string) {
    super(`Ja existe uma operacao em andamento para o slug "${slug}"`);
    this.name = "SessionBusyError";
  }
}

const SESSIONS_DIR = path.resolve(process.cwd(), ".sessions");
const LOCK_TTL_MS = 120_000;

const sessionKey = (slug: string) => `avec:session:${slug}`;
const lockKey = (slug: string) => `avec:lock:${slug}`;

/** Browsers abertos por este processo (evita reconectar via websocket). */
const liveBrowsers = new Map<string, Browser>();

async function readStored(slug: string): Promise<StoredSession | null> {
  const raw = await redis.get(sessionKey(slug));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
}

export async function saveStored(stored: StoredSession): Promise<void> {
  await redis.set(
    sessionKey(stored.slug),
    JSON.stringify(stored),
    "EX",
    config.SESSION_TTL_SECONDS,
  );
}

/** Renova o TTL de inatividade e atualiza lastUsedAt. */
export async function touchSession(slug: string): Promise<void> {
  const stored = await readStored(slug);
  if (!stored) return;
  stored.lastUsedAt = new Date().toISOString();
  await saveStored(stored);
}

async function resolveLiveBrowser(stored: StoredSession): Promise<Browser | null> {
  const local = liveBrowsers.get(stored.slug);
  if (local?.connected) return local;
  liveBrowsers.delete(stored.slug);

  try {
    const browser = await puppeteer.connect({ browserWSEndpoint: stored.wsEndpoint });
    liveBrowsers.set(stored.slug, browser);
    return browser;
  } catch {
    return null;
  }
}

/** Abre uma aba ja autenticada no proxy da sessao. */
export async function openPage(
  browser: Browser,
  slug: string,
  sessionId: string,
): Promise<Page> {
  const page = await browser.newPage();
  attachAvecLogger(page, slug);
  const proxy = buildProxySettings(sessionId, await getBridgeCached(slug));
  if (proxy) {
    await page.authenticate({ username: proxy.username, password: proxy.password });
  }
  return page;
}

/** Reaproveita a primeira aba aberta ou cria uma nova. */
export async function getPage(
  browser: Browser,
  slug: string,
  sessionId: string,
): Promise<Page> {
  const pages = await browser.pages();
  const existing = pages.find((p) => !p.isClosed() && p.url() !== "about:blank");
  if (existing) {
    attachAvecLogger(existing, slug);
    return existing;
  }
  const blank = pages.find((p) => !p.isClosed());
  if (blank) {
    attachAvecLogger(blank, slug);
    const proxy = buildProxySettings(sessionId, await getBridgeCached(slug));
    if (proxy) await blank.authenticate({ username: proxy.username, password: proxy.password });
    return blank;
  }
  return openPage(browser, slug, sessionId);
}

async function launchSession(slug: string, bridge: Bridge | null): Promise<SessionHandle> {
  const sessionId = newProxySessionId();
  const proxy = buildProxySettings(sessionId, bridge);
  noteCall({ sessionId, zone: bridge?.brdZone ?? null, salaoId: bridge?.salaoId ?? null, reused: false });

  // Sessao nova = IP novo = perfil limpo (nao carregar cookies de outro IP).
  const userDataDir = path.join(SESSIONS_DIR, path.basename(slug));
  await rm(userDataDir, { recursive: true, force: true });
  await mkdir(userDataDir, { recursive: true });

  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--window-size=1366,850",
    "--lang=pt-BR",
  ];
  if (proxy) args.push(`--proxy-server=${proxy.server}`);

  const browser = await puppeteer.launch({
    headless: config.PUPPETEER_HEADLESS,
    userDataDir,
    args,
    defaultViewport: { width: 1366, height: 850 },
  });
  liveBrowsers.set(slug, browser);
  browser.on("disconnected", () => {
    if (liveBrowsers.get(slug) === browser) liveBrowsers.delete(slug);
  });

  const page = await getPage(browser, slug, sessionId);
  let proxyIp: string | null = null;
  let proxyCountry: string | null = null;
  if (proxy) {
    const exit = await fetchExitIp(async (url) => {
      const res = await page.goto(url, { timeout: 20_000, waitUntil: "domcontentloaded" });
      return (await res?.text()) ?? "";
    });
    proxyIp = exit?.ip ?? null;
    proxyCountry = exit?.country ?? null;
    noteCall({ proxyIp, proxyCountry });
    // Regra: so IPs do Brasil (a AVEC barra o resto). Vale tambem para zones antigas/manuais.
    if (exit && exit.country !== BRD_COUNTRY.toUpperCase()) {
      await browser.close().catch(() => undefined);
      liveBrowsers.delete(slug);
      logger.error({ slug, proxyIp, country: exit.country, zone: bridge?.brdZone }, "proxy_not_brazil");
      throw new ProxyUnavailableError(
        `O IP de saida (${exit.ip}) nao e do Brasil (${exit.country ?? "pais desconhecido"}); ` +
          `a zone "${bridge?.brdZone ?? "?"}" precisa ter IPs brasileiros`,
      );
    }
    if (!proxyIp) {
      await browser.close().catch(() => undefined);
      liveBrowsers.delete(slug);
      throw new ProxyUnavailableError(
        "Nao foi possivel obter um IP pelo proxy (verifique as credenciais da Bright Data)",
      );
    }
  }

  noteCall({ proxyIp, proxyCountry });
  const now = new Date().toISOString();
  const stored: StoredSession = {
    slug,
    sessionId,
    wsEndpoint: browser.wsEndpoint(),
    proxyIp,
    proxyCountry,
    email: null,
    loggedIn: false,
    createdAt: now,
    lastUsedAt: now,
  };
  await saveStored(stored);
  logger.info({ slug, sessionId, proxyIp }, "session_created");
  return { browser, stored, reused: false };
}

export class ProxyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProxyUnavailableError";
  }
}

/** Fecha o Chromium e apaga a sessao do Redis. */
export async function destroySession(slug: string): Promise<void> {
  const browser = liveBrowsers.get(slug);
  liveBrowsers.delete(slug);
  if (browser) {
    await browser.close().catch(() => undefined);
  } else {
    const stored = await readStored(slug);
    if (stored) {
      try {
        const b = await puppeteer.connect({ browserWSEndpoint: stored.wsEndpoint });
        await b.close();
      } catch {
        /* ja morto */
      }
    }
  }
  await redis.del(sessionKey(slug));
}

/**
 * Executa `fn` com exclusividade por slug. Se a sessao existir no Redis e o
 * Chromium estiver vivo, reaproveita; caso contrario cria uma nova (novo IP).
 */
export async function withSession<T>(
  slug: string,
  fn: (handle: SessionHandle) => Promise<T>,
  opts: {
    /** Retorna true para descartar a sessao existente e abrir outra (novo IP). */
    shouldReset?: (stored: StoredSession) => boolean;
    /** Resolve (ou cria) a ponte Bright Data; so e chamado ao abrir um novo Chromium. */
    resolveBridge: () => Promise<Bridge | null>;
  },
): Promise<T> {
  const { shouldReset, resolveBridge } = opts;
  const token = randomUUID();
  const locked = await redis.set(lockKey(slug), token, "PX", LOCK_TTL_MS, "NX");
  if (locked !== "OK") throw new SessionBusyError(slug);
  bindCall(slug);

  try {
    let handle: SessionHandle | null = null;
    let stored = await readStored(slug);
    if (stored && shouldReset?.(stored)) {
      await destroySession(slug);
      stored = null;
    }
    if (stored) {
      const browser = await resolveLiveBrowser(stored);
      if (browser) {
        handle = { browser, stored, reused: true };
        noteCall({
          sessionId: stored.sessionId,
          proxyIp: stored.proxyIp,
          proxyCountry: stored.proxyCountry ?? null,
          reused: true,
          ...(await bridgeNote(slug)),
        });
      } else {
        await redis.del(sessionKey(slug));
      }
    }
    if (!handle) {
      const bridge = await resolveBridge();
      handle = await launchSession(slug, bridge);
    }
    return await fn(handle);
  } finally {
    releaseCall(slug);
    // libera o lock somente se ainda for nosso
    const current = await redis.get(lockKey(slug));
    if (current === token) await redis.del(lockKey(slug));
  }
}

export class NoSessionError extends Error {
  constructor(slug: string) {
    super(`Nao ha sessao aberta para "${slug}". Faca login em POST /auth/login primeiro.`);
    this.name = "NoSessionError";
  }
}

/**
 * Executa `fn` com exclusividade por slug usando APENAS uma sessao ja existente
 * (nao cria Chromium nem IP). Lanca NoSessionError se nao houver sessao logada.
 */
export async function withExistingSession<T>(
  slug: string,
  fn: (handle: SessionHandle) => Promise<T>,
): Promise<T> {
  const token = randomUUID();
  const locked = await redis.set(lockKey(slug), token, "PX", LOCK_TTL_MS, "NX");
  if (locked !== "OK") throw new SessionBusyError(slug);
  bindCall(slug);

  try {
    const stored = await readStored(slug);
    if (!stored || !stored.loggedIn) throw new NoSessionError(slug);
    noteCall({
      sessionId: stored.sessionId,
      proxyIp: stored.proxyIp,
      proxyCountry: stored.proxyCountry ?? null,
      reused: true,
      ...(await bridgeNote(slug)),
    });
    const browser = await resolveLiveBrowser(stored);
    if (!browser) {
      await redis.del(sessionKey(slug));
      throw new NoSessionError(slug);
    }
    return await fn({ browser, stored, reused: true });
  } finally {
    releaseCall(slug);
    const current = await redis.get(lockKey(slug));
    if (current === token) await redis.del(lockKey(slug));
  }
}

export async function shutdownSessions(): Promise<void> {
  const slugs = [...liveBrowsers.keys()];
  await Promise.all(slugs.map((slug) => destroySession(slug).catch(() => undefined)));
}
