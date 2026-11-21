import mysql from "mysql2/promise";
import { config } from "./config.js";
import { logger } from "./logger.js";

export const pool = mysql.createPool({
  host: config.DB_HOST,
  port: config.DB_PORT,
  user: config.DB_USERNAME,
  password: config.DB_PASSWORD,
  database: config.DB_DATABASE,
  waitForConnections: true,
  connectionLimit: 5,
  connectTimeout: 10_000,
  charset: "utf8mb4",
});

/** Cria a tabela customers_bridget caso ainda nao exista. */
export async function ensureSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers_bridget (
      id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      slug          VARCHAR(64)  NOT NULL,
      salao_id      BIGINT UNSIGNED NULL,
      nome          VARCHAR(255) NULL,
      email         VARCHAR(255) NOT NULL,
      brd_host      VARCHAR(255) NOT NULL,
      brd_port      INT UNSIGNED NOT NULL,
      brd_customer  VARCHAR(64)  NOT NULL,
      brd_zone      VARCHAR(128) NOT NULL,
      brd_country   VARCHAR(2)   NOT NULL DEFAULT 'br',
      brd_password  VARCHAR(255) NOT NULL,
      active        TINYINT(1)   NOT NULL DEFAULT 1,
      created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_customers_bridget_slug (slug),
      UNIQUE KEY uq_customers_bridget_zone (brd_zone),
      KEY idx_customers_bridget_salao_id (salao_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  // Tabelas criadas antes da coluna salao_id
  await pool.query(
    "ALTER TABLE customers_bridget ADD COLUMN IF NOT EXISTS salao_id BIGINT UNSIGNED NULL AFTER slug",
  );
  await pool.query(
    "ALTER TABLE customers_bridget ADD COLUMN IF NOT EXISTS nome VARCHAR(255) NULL AFTER salao_id",
  );
  await pool.query(
    "ALTER TABLE customers_bridget ADD COLUMN IF NOT EXISTS brd_country VARCHAR(2) NOT NULL DEFAULT 'br' AFTER brd_zone",
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_customers_bridget_salao_id ON customers_bridget (salao_id)",
  );
  // Sessao do Chromium (wsEndpoint = "token" de reconexao, IP, login...) em JSON
  await pool.query(
    "ALTER TABLE customers_bridget ADD COLUMN IF NOT EXISTS session_data TEXT NULL AFTER brd_password",
  );

  // Uma linha por chamada a esta API (rota, quando, resultado, IP/zona usados)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_call_log (
      id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      call_id        CHAR(36)     NOT NULL,
      created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      route          VARCHAR(64)  NOT NULL,
      slug           VARCHAR(64)  NULL,
      salao_id       BIGINT UNSIGNED NULL,
      http_status    SMALLINT UNSIGNED NOT NULL,
      error_code     VARCHAR(64)  NULL,
      duration_ms    INT UNSIGNED NOT NULL,
      session_id     VARCHAR(32)  NULL,
      session_reused TINYINT(1)   NULL,
      proxy_ip       VARCHAR(45)  NULL,
      proxy_country  VARCHAR(2)   NULL,
      brd_zone       VARCHAR(128) NULL,
      avec_requests  INT UNSIGNED NOT NULL DEFAULT 0,
      avec_errors    INT UNSIGNED NOT NULL DEFAULT 0,
      avec_blocks    INT UNSIGNED NOT NULL DEFAULT 0,
      PRIMARY KEY (id),
      UNIQUE KEY uq_api_call_log_call (call_id),
      KEY idx_api_call_log_created (created_at),
      KEY idx_api_call_log_slug (slug, created_at),
      KEY idx_api_call_log_route (route, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Uma linha por resposta HTTP da AVEC (documentos/XHR/fetch) vista no navegador
  await pool.query(`
    CREATE TABLE IF NOT EXISTS avec_response_log (
      id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      call_id       CHAR(36)     NULL,
      created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      slug          VARCHAR(64)  NULL,
      salao_id      BIGINT UNSIGNED NULL,
      route_hint    VARCHAR(64)  NULL,
      brd_zone      VARCHAR(128) NULL,
      proxy_ip      VARCHAR(45)  NULL,
      proxy_country VARCHAR(2)   NULL,
      session_id    VARCHAR(32)  NULL,
      method        VARCHAR(8)   NOT NULL,
      host          VARCHAR(128) NOT NULL,
      path          VARCHAR(255) NOT NULL,
      resource_type VARCHAR(16)  NOT NULL,
      status        SMALLINT UNSIGNED NULL,
      error_text    VARCHAR(128) NULL,
      is_block      TINYINT(1)   NOT NULL DEFAULT 0,
      server        VARCHAR(64)  NULL,
      headers       TEXT         NULL,
      body_snippet  VARCHAR(500) NULL,
      latency_ms    INT UNSIGNED NULL,
      PRIMARY KEY (id),
      KEY idx_avec_resp_created (created_at),
      KEY idx_avec_resp_call (call_id),
      KEY idx_avec_resp_status (status, created_at),
      KEY idx_avec_resp_ip (proxy_ip, created_at),
      KEY idx_avec_resp_block (is_block, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  // Tabelas de log criadas antes da coluna proxy_country
  await pool.query(
    "ALTER TABLE api_call_log ADD COLUMN IF NOT EXISTS proxy_country VARCHAR(2) NULL AFTER proxy_ip",
  );
  await pool.query(
    "ALTER TABLE avec_response_log ADD COLUMN IF NOT EXISTS proxy_country VARCHAR(2) NULL AFTER proxy_ip",
  );
  logger.info("db_schema_ready");
}
