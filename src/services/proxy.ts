import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import type { Bridge } from "./bridge.js";

/**
 * Todo cliente novo e provisionado com IPs do Brasil (ISO-3166, minusculo na API da
 * Bright Data). A AVEC barra IPs de fora (ELB 403), entao nao e configuravel.
 */
export const BRD_COUNTRY = "br";

export interface ProxySettings {
  /** host:port passado em --proxy-server */
  server: string;
  username: string;
  password: string;
}

/** Gera um id de sessao Bright Data. Id novo = IP novo; mesmo id = mesmo IP. */
export function newProxySessionId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Monta as credenciais do proxy a partir da ponte do cliente:
 * brd-customer-<customer>-zone-<zone>-session-<sessionId>
 * Retorna null quando PROXY_ENABLED=false ou quando nao ha ponte.
 */
export function buildProxySettings(
  sessionId: string,
  bridge: Bridge | null,
): ProxySettings | null {
  if (!config.PROXY_ENABLED || !bridge) return null;

  return {
    server: `${bridge.brdHost}:${bridge.brdPort}`,
    username: `brd-customer-${bridge.brdCustomer}-zone-${bridge.brdZone}-session-${sessionId}`,
    password: bridge.brdPassword,
  };
}

export interface ExitIp {
  ip: string;
  /** ISO-3166 alpha-2 em maiusculo (ex.: "BR") ou null se desconhecido */
  country: string | null;
}

/** Descobre o IP (e o pais) de saida do Chromium pelo proxy. */
export async function fetchExitIp(
  fetchInPage: (url: string) => Promise<string>,
): Promise<ExitIp | null> {
  try {
    const raw = await fetchInPage("http://brdtest.com/myip.json");
    const parsed = JSON.parse(raw) as { ip?: string; country?: string };
    if (!parsed.ip) return null;
    return { ip: parsed.ip, country: parsed.country ? parsed.country.toUpperCase() : null };
  } catch {
    return null;
  }
}
