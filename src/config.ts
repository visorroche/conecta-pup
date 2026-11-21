import "dotenv/config";
import { z } from "zod";

const bool = z
  .enum(["true", "false"])
  .transform((v) => v === "true");

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3100),
  // Interface de escuta. Em producao fica em 127.0.0.1 (quem expoe e o nginx)
  HOST: z.string().default("127.0.0.1"),
  // Banco onde fica a tabela customers_bridget (uma "ponte" Bright Data por cliente)
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().positive().default(3306),
  DB_DATABASE: z.string().min(1),
  DB_USERNAME: z.string().min(1),
  DB_PASSWORD: z.string().default(""),

  // Bright Data. false = Chromium sem proxy (apenas testes locais)
  PROXY_ENABLED: bool.default(true),
  BRD_API_URL: z.string().url().default("https://api.brightdata.com"),
  BRD_API_KEY: z.string().default(""),
  /** host:port gravados em cada nova ponte */
  BRD_HOST: z.string().default("brd.superproxy.io"),
  BRD_PORT: z.coerce.number().int().positive().default(44445),
  /** Prefixo do nome da zone criada para cada cliente (apenas a-z, 0-9 e _) */
  BRD_ZONE_PREFIX: z.string().regex(/^[a-z0-9_]*$/).default("avec_"),
  /** Quantidade de IPs dedicados por zone/cliente */
  BRD_ZONE_IPS: z.coerce.number().int().positive().default(1),
  /** Trava de seguranca: maximo de pontes (zones pagas) criadas automaticamente */
  BRD_MAX_BRIDGES: z.coerce.number().int().positive().default(50),

  AVEC_ADMIN_BASE: z.string().url().default("https://admin.avec.beauty"),
  PUPPETEER_HEADLESS: bool.default(true),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(1800),
  LOGIN_TIMEOUT_MS: z.coerce.number().int().positive().default(45000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Configuracao invalida:");
  for (const issue of parsed.error.issues) {
    console.error(`- ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = {
  ...parsed.data,
  BRD_API_URL: parsed.data.BRD_API_URL.replace(/\/+$/, ""),
  AVEC_ADMIN_BASE: parsed.data.AVEC_ADMIN_BASE.replace(/\/+$/, ""),
};
export type Config = typeof config;
