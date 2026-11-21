import { createHash } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { config } from "../config.js";
import { pool } from "../db.js";
import { logger } from "../logger.js";
import { BRD_COUNTRY } from "./proxy.js";

/**
 * "Ponte" de um cliente: credenciais de uma zone Bright Data dedicada ao slug.
 * Fica na tabela customers_bridget.
 */
export interface Bridge {
  slug: string;
  salaoId: number | null;
  nome: string | null;
  /** pais dos IPs da zone (minusculo); novos clientes sao sempre "br" */
  brdCountry: string;
  email: string;
  brdHost: string;
  brdPort: number;
  brdCustomer: string;
  brdZone: string;
  brdPassword: string;
  active: boolean;
}

export class BridgeProvisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeProvisionError";
  }
}

export class CustomerInactiveError extends Error {
  constructor(public readonly slug: string) {
    super(`O cliente "${slug}" esta desativado (active=false)`);
    this.name = "CustomerInactiveError";
  }
}

interface BridgeRow extends RowDataPacket {
  slug: string;
  salao_id: number | string | null;
  nome: string | null;
  brd_country: string | null;
  email: string;
  brd_host: string;
  brd_port: number;
  brd_customer: string;
  brd_zone: string;
  brd_password: string;
  active: number;
}

const cache = new Map<string, Bridge>();

function fromRow(row: BridgeRow): Bridge {
  return {
    slug: row.slug,
    salaoId: row.salao_id === null ? null : Number(row.salao_id),
    nome: row.nome ?? null,
    brdCountry: (row.brd_country ?? "br").toLowerCase(),
    email: row.email,
    brdHost: row.brd_host,
    brdPort: row.brd_port,
    brdCustomer: row.brd_customer,
    brdZone: row.brd_zone,
    brdPassword: row.brd_password,
    active: row.active === 1,
  };
}

/** Le a ponte do banco (sempre fresco: `active` pode mudar a qualquer momento). */
export async function findBridge(slug: string): Promise<Bridge | null> {
  const [rows] = await pool.query<BridgeRow[]>(
    "SELECT * FROM customers_bridget WHERE slug = ? LIMIT 1",
    [slug],
  );
  const row = rows[0];
  if (!row) {
    cache.delete(slug);
    return null;
  }
  const bridge = fromRow(row);
  cache.set(slug, bridge);
  return bridge;
}

/** Acha a ponte (e portanto o slug) pelo salao_id. */
export async function findBridgeBySalaoId(salaoId: number): Promise<Bridge | null> {
  const [rows] = await pool.query<BridgeRow[]>(
    "SELECT * FROM customers_bridget WHERE salao_id = ? ORDER BY active DESC, id ASC LIMIT 1",
    [salaoId],
  );
  const row = rows[0];
  if (!row) return null;
  const bridge = fromRow(row);
  cache.set(bridge.slug, bridge);
  return bridge;
}

/** Grava o salao_id lido da AVEC (rodape) na linha do slug, se estiver vazio ou diferente. */
/** Grava salao_id e nome lidos do rodape da AVEC ("ID Cliente: N - NOME"), so se mudaram. */
export async function saveClientInfo(
  slug: string,
  info: { salaoId: number; name: string | null },
): Promise<void> {
  const nome = info.name && info.name.length > 0 ? info.name.slice(0, 255) : null;
  const [res] = await pool.query<ResultSetHeader>(
    `UPDATE customers_bridget
        SET salao_id = ?, nome = COALESCE(?, nome)
      WHERE slug = ?
        AND (salao_id IS NULL OR salao_id <> ? OR (? IS NOT NULL AND (nome IS NULL OR nome <> ?)))`,
    [info.salaoId, nome, slug, info.salaoId, nome, nome],
  );
  if (res.affectedRows > 0) logger.info({ slug, salaoId: info.salaoId, nome }, "client_info_updated");
  cache.delete(slug);
}

/** Ponte em memoria (usada ao abrir novas abas de uma sessao ja ativa). */
export async function getBridgeCached(slug: string): Promise<Bridge | null> {
  return cache.get(slug) ?? findBridge(slug);
}

// ---------------------------------------------------------------- Bright Data API

async function brdApi<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  if (!config.BRD_API_KEY) {
    throw new BridgeProvisionError("BRD_API_KEY nao configurada");
  }
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${config.BRD_API_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.BRD_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    text = await res.text();
  } catch (err) {
    throw new BridgeProvisionError(
      `Bright Data ${method} ${path.split("?")[0]} falhou: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    throw new BridgeProvisionError(
      `Bright Data ${method} ${path.split("?")[0]} -> HTTP ${res.status}: ${text.slice(0, 300)}`,
    );
  }
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

let customerIdCache: string | null = null;

async function getCustomerId(): Promise<string> {
  if (customerIdCache) return customerIdCache;
  const status = await brdApi<{ customer?: string }>("GET", "/status");
  if (!status.customer) throw new BridgeProvisionError("Bright Data nao retornou o customer id");
  customerIdCache = status.customer;
  return customerIdCache;
}

/** Nome da zone do cliente: apenas a-z, 0-9 e _, com hash para evitar colisao entre slugs. */
export function zoneNameFor(slug: string): string {
  // A Bright Data aceita no maximo 30 caracteres e so letras, digitos e "_" (testado na API).
  const MAX_LEN = 30;
  const hash = createHash("sha1").update(slug).digest("hex").slice(0, 6);
  const room = Math.max(0, MAX_LEN - config.BRD_ZONE_PREFIX.length - hash.length - 1);
  const clean = slug.toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, room);
  return `${config.BRD_ZONE_PREFIX}${clean}_${hash}`.slice(0, MAX_LEN);
}

function extractPassword(payload: unknown): string | null {
  if (typeof payload === "string" && payload) return payload;
  if (Array.isArray(payload)) {
    const first = payload.find((v) => typeof v === "string" && v);
    return (first as string | undefined) ?? null;
  }
  if (payload && typeof payload === "object") {
    for (const value of Object.values(payload)) {
      const found = extractPassword(value);
      if (found) return found;
    }
  }
  return null;
}

async function fetchZonePassword(zone: string): Promise<string | null> {
  const payload = await brdApi<unknown>("GET", `/zone/passwords?zone=${encodeURIComponent(zone)}`);
  return extractPassword(payload);
}

/** Cria (ou reaproveita, se ja existir) a zone ISP dedicada do cliente e devolve a senha. */
async function provisionZone(zone: string): Promise<string> {
  try {
    await brdApi("POST", "/zone", {
      zone: { name: zone, type: "ISP" },
      plan: {
        type: "static",
        pool_ip_type: "static_res",
        ips_type: "dedicated",
        bandwidth: "unlimited",
        unl_bw_tiers: "std",
        country: BRD_COUNTRY,
        ips: config.BRD_ZONE_IPS,
      },
    });
  } catch (createErr) {
    // A zone pode ja existir (ex.: falha anterior entre criar a zone e gravar a linha).
    const existing = await fetchZonePassword(zone).catch(() => null);
    if (!existing) throw createErr;
    logger.warn({ zone }, "bridge_zone_already_existed");
    return existing;
  }

  // A zone pode levar um instante para aparecer na API de senhas.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const password = await fetchZonePassword(zone);
      if (password) return password;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  throw lastErr instanceof Error
    ? lastErr
    : new BridgeProvisionError(`Zone "${zone}" criada, mas a senha nao foi retornada`);
}

// ---------------------------------------------------------------- public API

/**
 * Busca a ponte do slug na tabela; se nao existir, cria a zone na Bright Data
 * e grava a linha (active=true por padrao).
 */
export async function ensureBridge(
  slug: string,
  email: string,
  salaoId: number | null = null,
): Promise<Bridge> {
  const existing = await findBridge(slug);
  if (existing) {
    if (!existing.active) throw new CustomerInactiveError(slug);
    return existing;
  }

  const [countRows] = await pool.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS total FROM customers_bridget",
  );
  if (Number(countRows[0]?.total ?? 0) >= config.BRD_MAX_BRIDGES) {
    throw new BridgeProvisionError(
      `Limite de ${config.BRD_MAX_BRIDGES} pontes atingido (BRD_MAX_BRIDGES)`,
    );
  }

  const zone = zoneNameFor(slug);
  const [customer, password] = await Promise.all([getCustomerId(), provisionZone(zone)]);

  try {
    await pool.query<ResultSetHeader>(
      `INSERT INTO customers_bridget
         (slug, salao_id, email, brd_host, brd_port, brd_customer, brd_zone, brd_password, brd_country, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [slug, salaoId, email, config.BRD_HOST, config.BRD_PORT, customer, zone, password, BRD_COUNTRY],
    );
  } catch (err) {
    // outra instancia gravou primeiro
    if ((err as { code?: string }).code !== "ER_DUP_ENTRY") throw err;
    const raced = await findBridge(slug);
    if (raced) {
      if (!raced.active) throw new CustomerInactiveError(slug);
      return raced;
    }
    throw err;
  }

  logger.info({ slug, zone }, "bridge_created");
  const created = await findBridge(slug);
  if (!created) throw new BridgeProvisionError("Ponte criada mas nao encontrada no banco");
  return created;
}
