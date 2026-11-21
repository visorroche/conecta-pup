import type { ElementHandle, Page } from "puppeteer";
import { config } from "../config.js";
import { logger } from "../logger.js";

export interface ComandaItem {
  /** Valor bruto de itemTipo da AVEC (ex.: "salao_servicos") */
  tipo: string | null;
  item: string;
  profissional: string | null;
  comissao_pct: number | null;
  quantidade: number | null;
  valor_unitario: number | null;
  desconto_pct: number | null;
  total: number | null;
}

export interface ComandaPagamento {
  forma: string;
  informacao: string | null;
  parcelas: number | null;
  data_cobranca: string | null;
  valor: number | null;
}

export interface ComandaLida {
  origem: "abertas" | "finalizadas";
  numero: number;
  data: string;
  cliente: string | null;
  caixa: string | null;
  aberta_em: string | null;
  valor: number | null;
  itens: ComandaItem[];
  pagamentos: ComandaPagamento[];
  resumo_pagamento: {
    caixa: string | null;
    saldo_cliente: number | null;
    total: number | null;
    a_cobrar: number | null;
    troco: number | null;
  };
}

export type ReadComandaResult =
  | { ok: true; comanda: ComandaLida }
  | { ok: false; reason: "not_found" | "session_expired" | "timeout"; message: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SEARCH_INPUT = "#tableFilter_filter input[type=search]";

interface RowInfo {
  index: number;
  cells: string[];
}

/** "08" -> "0008" (a AVEC exibe o numero com 4 digitos: Nº0006). */
function numeroLabel(numero: number): string {
  return `Nº${String(numero).padStart(4, "0")}`;
}

function toNumber(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const clean = String(raw).replace(/R\$/g, "").replace(/\s/g, "");
  if (clean === "") return null;
  // "1.234,56" (pt-BR) ou "1234.56"
  const normalized = clean.includes(",") ? clean.replace(/\./g, "").replace(",", ".") : clean;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/** Digita no campo "Buscar" do DataTable e espera filtrar. */
async function searchTable(page: Page, text: string): Promise<void> {
  await page.waitForSelector(SEARCH_INPUT, { visible: true, timeout: 20_000 });
  await page.click(SEARCH_INPUT);
  await page.keyboard.down("Control");
  await page.keyboard.press("KeyA");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  await page.type(SEARCH_INPUT, text, { delay: 40 });
  await sleep(900);
}

/** Acha a linha cuja 1a coluna e exatamente "NºXXXX (dd/mm/aaaa)". */
async function findExactRow(page: Page, numero: number, data: string): Promise<RowInfo | null> {
  const label = numeroLabel(numero);
  return page.evaluate(
    (lbl, dt) => {
      const rows = Array.from(document.querySelectorAll("#tableFilter tbody tr"));
      for (let i = 0; i < rows.length; i++) {
        const cells = Array.from(rows[i]!.querySelectorAll("td")).map((td) =>
          (td.textContent ?? "").replace(/\s+/g, " ").trim(),
        );
        const first = cells[0] ?? "";
        const m = /^N[ºo°]\s*(\d+)\s*\((\d{2}\/\d{2}\/\d{4})\)/i.exec(first);
        if (m && m[2] === dt && Number(m[1]) === Number(lbl.replace(/\D/g, ""))) {
          return { index: i, cells };
        }
      }
      return null;
    },
    label,
    data,
  );
}

function addDays(br: string, days: number): string {
  const [d, m, y] = br.split("/").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d + days));
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${date.getUTCFullYear()}`;
}

function minDate(a: string, b: string): string {
  const key = (s: string) => s.split("/").reverse().join("");
  return key(a) <= key(b) ? a : b;
}

/** Filtra o historico (comandas finalizadas) por periodo e clica em Buscar. */
async function setHistoricoRange(page: Page, ini: string, fim: string): Promise<void> {
  await page.waitForSelector("#dataini", { visible: true, timeout: 20_000 });
  await page.evaluate(
    (a, b) => {
      for (const [id, value] of [
        ["dataini", a],
        ["datafim", b],
      ] as const) {
        const el = document.getElementById(id) as HTMLInputElement | null;
        if (!el) continue;
        el.value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    },
    ini,
    fim,
  );
  const button = await page.evaluateHandle(
    `Array.from(document.querySelectorAll("a.btn")).find(function (e) { return /^\\s*Buscar\\s*$/.test(e.textContent || "") && e.getBoundingClientRect().width > 0; })`,
  );
  const el = button.asElement() as ElementHandle<Element> | null;
  if (!el) throw new Error("botao Buscar do historico nao encontrado");
  await el.click();
  await page.waitForNetworkIdle({ idleTime: 1200, timeout: 25_000 }).catch(() => undefined);
  await sleep(800);
}

/** Abre o modal pelo lapis da linha e le as abas Itens e Pagamento. */
async function readModal(page: Page, rowIndex: number): Promise<{
  itens: ComandaItem[];
  pagamentos: ComandaPagamento[];
  resumo: ComandaLida["resumo_pagamento"];
}> {
  const pencil = await page.$(`#tableFilter tbody tr:nth-child(${rowIndex + 1}) a i.icon-pencil`);
  if (!pencil) throw new Error("lapis de edicao nao encontrado na linha");
  await pencil.click();

  await page.waitForSelector("#popupModal #itensComanda", { visible: true, timeout: 25_000 });
  // os itens sao montados via ajax: espera a quantidade de linhas estabilizar
  let last = -1;
  for (let i = 0; i < 12; i++) {
    await sleep(700);
    const count = await page.evaluate(
      () => document.querySelectorAll("#itensComanda tbody tr.itemComanda").length,
    );
    if (count === last && i >= 2) break;
    last = count;
  }

  // selects de profissional/servico sao preenchidos depois das linhas: espera (ate 8s)
  for (let i = 0; i < 16; i++) {
    const pending = await page.evaluate(
      `Array.from(document.querySelectorAll("#itensComanda tbody tr.itemComanda select[name^='idProf'], #itensComanda tbody tr.itemComanda select[name^='idTipo']")).filter(function (s) { return !s.options[s.selectedIndex] || !(s.options[s.selectedIndex].text || "").trim(); }).length`,
    );
    if (pending === 0) break;
    await sleep(500);
  }

  const itensRaw = (await page.evaluate(`Array.from(document.querySelectorAll("#itensComanda tbody tr.itemComanda")).map(function (tr) {
    var get = function (n) {
      var e = tr.querySelector("[name^='" + n + "']");
      if (!e) return null;
      if (e.tagName === "SELECT") return e.options[e.selectedIndex] ? e.options[e.selectedIndex].text : "";
      return e.value;
    };
    return { tipo: get("itemTipo"), item: get("item["), prof: get("idProf"), com: get("comissao"), qtd: get("itemQtde"), valor: get("itemValor"), desc: get("itemDesconto"), total: get("itemTotal"), tipoText: get("idTipo") };
  })`)) as Array<Record<string, string | null>>;

  const itens: ComandaItem[] = itensRaw.map((r) => ({
    tipo: r.tipo || null,
    item: (r.item || r.tipoText || "").trim(),
    profissional: r.prof ? r.prof.trim() || null : null,
    comissao_pct: toNumber(r.com),
    quantidade: toNumber(r.qtd),
    valor_unitario: toNumber(r.valor),
    desconto_pct: toNumber(r.desc),
    total: toNumber(r.total),
  }));

  // Aba Pagamento
  await page.evaluate(
    `Array.from(document.querySelectorAll("#popupModal ul.nav a")).filter(function (a) { return /Pagamento/i.test(a.textContent || ""); })[0].click()`,
  );
  await page.waitForSelector("#formaPagamento", { visible: true, timeout: 10_000 });
  await sleep(1200);

  const pagRaw = (await page.evaluate(`Array.from(document.querySelectorAll("#formaPagamento tbody tr")).map(function (tr) {
    var get = function (n) {
      var e = tr.querySelector("[name^='" + n + "']");
      if (!e) return null;
      if (e.tagName === "SELECT") return e.options[e.selectedIndex] ? e.options[e.selectedIndex].text : "";
      return e.value;
    };
    return { forma: get("tipoPagamento"), info: get("informacao"), parc: get("parcelas"), cobr: get("dataCobranca"), valor: get("valorPago") };
  })`)) as Array<Record<string, string | null>>;

  // A linha padrao "Dinheiro 0.00" de uma comanda sem pagamento e so um placeholder
  const pagamentos: ComandaPagamento[] = pagRaw
    .map((r) => ({
      forma: (r.forma ?? "").trim(),
      informacao: r.info ? r.info.trim() || null : null,
      parcelas: toNumber(r.parc),
      data_cobranca: r.cobr ? r.cobr.trim() || null : null,
      valor: toNumber(r.valor),
    }))
    .filter((p) => p.forma !== "" && ((p.valor ?? 0) > 0 || p.informacao !== null));

  const resumoRaw = (await page.evaluate(`(function () {
    var out = {};
    ["caixaId", "saldoAnterior", "total", "cobrar", "troco"].forEach(function (id) {
      var e = document.getElementById(id);
      out[id] = e ? (e.tagName === "SELECT" ? (e.options[e.selectedIndex] ? e.options[e.selectedIndex].text : "") : e.value) : null;
    });
    return out;
  })()`)) as Record<string, string | null>;

  const caixa = resumoRaw.caixaId?.trim() ?? null;
  const resumo = {
    caixa: caixa && !/^selecione/i.test(caixa) ? caixa : null,
    saldo_cliente: toNumber(resumoRaw.saldoAnterior),
    total: toNumber(resumoRaw.total),
    a_cobrar: toNumber(resumoRaw.cobrar),
    troco: toNumber(resumoRaw.troco),
  };

  // fecha o modal (sem salvar nada)
  await page.click("#popupModal button.close").catch(() => undefined);
  return { itens, pagamentos, resumo };
}

/**
 * Busca uma comanda por data e numero: primeiro em Financeiro (abertas) e,
 * se nao achar, em Comandas Finalizadas (historico). Le os itens e pagamentos.
 */
export async function readComanda(
  page: Page,
  input: { numero: number; data: string },
): Promise<ReadComandaResult> {
  const timeout = config.LOGIN_TIMEOUT_MS;
  const phrase = `${numeroLabel(input.numero)} (${input.data})`;

  // 1) Comandas abertas
  await page.goto(`${config.AVEC_ADMIN_BASE}/admin/financeiro`, {
    waitUntil: "domcontentloaded",
    timeout,
  });
  try {
    await page.waitForSelector(SEARCH_INPUT, { visible: true, timeout: 20_000 });
  } catch {
    return {
      ok: false,
      reason: "session_expired",
      message: "Nao foi possivel abrir o Financeiro; a sessao pode ter expirado. Faca login novamente.",
    };
  }
  await sleep(1000);
  await searchTable(page, phrase);
  let row = await findExactRow(page, input.numero, input.data);
  let origem: ComandaLida["origem"] = "abertas";

  // 2) Historico (finalizadas): 1o so o dia da comanda; depois uma janela maior
  if (!row) {
    origem = "finalizadas";
    await page.goto(`${config.AVEC_ADMIN_BASE}/admin/financeiro/comanda/historico`, {
      waitUntil: "domcontentloaded",
      timeout,
    });
    const today = new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(new Date());
    const ranges: Array<[string, string]> = [
      [input.data, input.data],
      [addDays(input.data, -15), minDate(addDays(input.data, 30), today)],
    ];
    for (const [ini, fim] of ranges) {
      await setHistoricoRange(page, ini, fim);
      await searchTable(page, phrase);
      row = await findExactRow(page, input.numero, input.data);
      if (row) break;
      logger.info({ ini, fim, phrase }, "comanda_not_in_range");
    }
  }

  if (!row) {
    return {
      ok: false,
      reason: "not_found",
      message: `Comanda ${numeroLabel(input.numero)} de ${input.data} nao encontrada (abertas nem finalizadas)`,
    };
  }

  const modal = await readModal(page, row.index);
  // colunas: abertas = [comanda, cliente, abertura, valor, acoes]
  //          finalizadas = [comanda, cliente, caixa, abertura, valor, acoes]
  const cells = row.cells;
  const finalizada = origem === "finalizadas";
  return {
    ok: true,
    comanda: {
      origem,
      numero: input.numero,
      data: input.data,
      cliente: cells[1] ?? null,
      caixa: finalizada ? (cells[2] ?? null) : modal.resumo.caixa,
      aberta_em: (finalizada ? cells[3] : cells[2]) ?? null,
      valor: toNumber(finalizada ? cells[4] : cells[3]),
      itens: modal.itens,
      pagamentos: modal.pagamentos,
      resumo_pagamento: modal.resumo,
    },
  };
}
