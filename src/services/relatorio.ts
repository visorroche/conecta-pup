import type { ElementHandle, Page } from "puppeteer";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { normalizeDate } from "./comandas.js";

export interface RelatorioResultado {
  codigo: string;
  titulo: string | null;
  filtros: Record<string, string>;
  totais: Record<string, string>;
  colunas: string[];
  total: number;
  linhas: Array<Record<string, string | null>>;
}

export type ReadRelatorioResult =
  | { ok: true; relatorio: RelatorioResultado }
  | {
      ok: false;
      reason: "session_expired" | "not_found" | "invalid_filter" | "invalid_value" | "unsupported" | "timeout";
      message: string;
      filtrosDisponiveis?: string[];
    };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface FormField {
  name: string;
  tag: string;
  format: string | null;
  label: string | null;
  value: string;
}

/** Campos de filtro do relatorio (inputs/selects visiveis do #formRelatorio). */
async function readFormFields(page: Page): Promise<FormField[]> {
  return (await page.evaluate(`Array.from(document.querySelectorAll("#formRelatorio input[name], #formRelatorio select[name], #formRelatorio textarea[name]")).filter(function (e) {
    return e.type !== "hidden" && e.getBoundingClientRect().width > 0 && !/_length$/.test(e.name) && e.type !== "search";
  }).map(function (e) {
    return { name: e.name, tag: e.tagName, format: e.getAttribute("data-format"), label: e.getAttribute("data-label"), value: e.value };
  })`)) as FormField[];
}

function stripHtml(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

/**
 * Abre /admin/relatorio/{codigo}, preenche os filtros (pelo `name` dos inputs),
 * clica em Buscar e devolve as linhas da resposta de /admin/relatorios/listar.
 */
export async function readRelatorio(
  page: Page,
  codigo: string,
  filtros: Record<string, string>,
): Promise<ReadRelatorioResult> {
  const response = await page.goto(`${config.AVEC_ADMIN_BASE}/admin/relatorio/${encodeURIComponent(codigo)}`, {
    waitUntil: "domcontentloaded",
    timeout: config.LOGIN_TIMEOUT_MS,
  });
  if (response && response.status() === 404) {
    return { ok: false, reason: "not_found", message: `Relatorio ${codigo} nao encontrado` };
  }

  try {
    await page.waitForSelector("#formRelatorio", { timeout: 25_000 });
  } catch {
    const url = page.url();
    const onRelatorio = url.includes("/admin/relatorio/");
    return onRelatorio
      ? { ok: false, reason: "not_found", message: `Relatorio ${codigo} nao encontrado ou sem formulario de busca` }
      : {
          ok: false,
          reason: "session_expired",
          message: "Nao foi possivel abrir o relatorio; a sessao pode ter expirado. Faca login novamente.",
        };
  }

  // relatorios embutidos (Metabase) so tem um iframe: sem linhas para ler
  if (await page.$("#metabaseIframe")) {
    return {
      ok: false,
      reason: "unsupported",
      message: `O relatorio ${codigo} e exibido em um painel Metabase (iframe); nao ha linhas para ler`,
    };
  }

  // espera a carga inicial da tabela (a pagina ja consulta com o periodo padrao)
  await page.waitForNetworkIdle({ idleTime: 1200, timeout: 30_000 }).catch(() => undefined);

  const fields = await readFormFields(page);
  const available = fields.map((f) => f.name);

  // codigo inexistente: a AVEC responde 200 com titulo vazio ("-") e um formulario sem campos
  const hasSearch = await page.evaluate(
    `Array.from(document.querySelectorAll("button")).some(function (b) { return /Buscar/.test(b.textContent || "") && b.getBoundingClientRect().width > 0; })`,
  );
  if (fields.length === 0 && !hasSearch) {
    return { ok: false, reason: "not_found", message: `Relatorio ${codigo} nao encontrado` };
  }

  // Preenche os filtros recebidos
  for (const [name, rawValue] of Object.entries(filtros)) {
    const field = fields.find((f) => f.name === name);
    if (!field) {
      return {
        ok: false,
        reason: "invalid_filter",
        message: `O relatorio ${codigo} nao tem o filtro "${name}"`,
        filtrosDisponiveis: available,
      };
    }
    let value = rawValue;
    if (field.format && /dd\/MM\/yyyy/i.test(field.format)) {
      const normalized = normalizeDate(rawValue);
      if (!normalized) {
        return {
          ok: false,
          reason: "invalid_value",
          message: `Valor invalido para "${name}": use aaaa-mm-dd ou dd/mm/aaaa`,
        };
      }
      value = normalized;
    }

    if (field.tag === "SELECT") {
      const selector = `#formRelatorio select[name="${name}"]`;
      const chosen = await page.select(selector, value).catch(() => []);
      if (chosen.length === 0) {
        const options = (await page.evaluate(
          `Array.from(document.querySelectorAll('${selector} option')).map(function (o) { return o.value + "=" + o.text; })`,
        )) as string[];
        return {
          ok: false,
          reason: "invalid_value",
          message: `Valor invalido para "${name}". Opcoes: ${options.join(", ")}`,
        };
      }
    } else {
      await page.evaluate(
        (n, v) => {
          const el = document.querySelector(`#formRelatorio [name="${n}"]`) as HTMLInputElement | null;
          if (!el) return;
          el.value = v;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new Event("blur", { bubbles: true }));
        },
        name,
        value,
      );
    }
  }

  // Buscar -> captura a resposta de /admin/relatorios/listar
  const listar = page
    .waitForResponse(
      (r) => r.request().method() === "GET" && r.url().includes("/admin/relatorios/listar"),
      { timeout: 90_000 },
    )
    .catch(() => null);
  const button = (await page.evaluateHandle(
    `Array.from(document.querySelectorAll("button.search-button, button")).find(function (b) { return /Buscar/.test(b.textContent || "") && b.getBoundingClientRect().width > 0; })`,
  )).asElement() as ElementHandle<Element> | null;
  if (!button) {
    return { ok: false, reason: "unsupported", message: `O relatorio ${codigo} nao tem botao Buscar` };
  }
  await button.click();
  const listarResponse = await listar;
  if (!listarResponse) {
    return { ok: false, reason: "timeout", message: "A AVEC nao respondeu a busca do relatorio" };
  }
  const bodyText = await listarResponse.text().catch(() => "");
  let aaData: unknown[][] | null = null;
  try {
    const json = JSON.parse(bodyText) as { aaData?: unknown[][] };
    if (Array.isArray(json.aaData)) aaData = json.aaData;
  } catch {
    /* resposta nao-JSON */
  }
  if (!aaData) {
    logger.warn({ codigo, status: listarResponse.status(), body: bodyText.slice(0, 200) }, "relatorio_listar_unexpected");
    return {
      ok: false,
      reason: "unsupported",
      message: `Resposta inesperada da AVEC ao buscar o relatorio ${codigo} (HTTP ${listarResponse.status()})`,
    };
  }

  // a tabela e remontada pelo listar(): espera o cabecalho e os totais renderizarem
  await page.waitForNetworkIdle({ idleTime: 800, timeout: 15_000 }).catch(() => undefined);
  await sleep(600);

  const headers = (await page.evaluate(
    `Array.from(document.querySelectorAll("#tableFilter thead th")).map(function (th) { return (th.textContent || "").replace(/\\s+/g, " ").trim(); })`,
  )) as string[];
  const totaisRaw = (await page.evaluate(
    `Array.from(document.querySelectorAll("#totalRelatorio tr")).map(function (tr) { return Array.from(tr.querySelectorAll("td,th")).map(function (c) { return (c.textContent || "").replace(/\\s+/g, " ").trim(); }); })`,
  )) as string[][];
  const titulo = (await page.evaluate(
    `(function () { var hs = Array.from(document.querySelectorAll("h1,h2,h3,h4")); var h = hs.find(function (e) { return /^\\d+\\s*-\\s*\\S/.test((e.textContent || "").trim()); }); return h ? h.textContent.trim() : null; })()`,
  )) as string | null;
  const formAfter = await readFormFields(page);

  // chaves unicas por coluna (o relatorio pode repetir nomes)
  const seen = new Map<string, number>();
  const keys = headers.map((h, i) => {
    const base = h || `coluna_${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}_${n}`;
  });

  const linhas = aaData.map((row) => {
    const obj: Record<string, string | null> = {};
    row.forEach((cell, i) => {
      obj[keys[i] ?? `coluna_${i + 1}`] = stripHtml(cell);
    });
    return obj;
  });

  const totais: Record<string, string> = {};
  for (const cells of totaisRaw) {
    const label = cells[0];
    if (label && cells.length >= 2) totais[label] = cells[cells.length - 1] ?? "";
  }

  return {
    ok: true,
    relatorio: {
      codigo,
      titulo,
      filtros: Object.fromEntries(formAfter.map((f) => [f.name, f.value])),
      totais,
      colunas: keys,
      total: linhas.length,
      linhas,
    },
  };
}
