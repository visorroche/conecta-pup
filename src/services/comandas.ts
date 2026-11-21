import type { ElementHandle, Page } from "puppeteer";
import { config } from "../config.js";
import { logger } from "../logger.js";

/** Tipos do dropdown "Nome / E-mail / Telefone / CPF / Codigo de Cadastro" do modal. */
export type SearchType = "codigo" | "cpf" | "phone" | "email";

/** data-val-tipo de cada opcao em #slcClienteInicialTipoBusca (0 = Nome, nao usado aqui). */
const SEARCH_TYPE_INDEX: Record<SearchType, number> = {
  email: 1,
  phone: 2,
  cpf: 3,
  codigo: 4,
};

const SEL = {
  openButton: "#btnAbrirComanda",
  dropdownToggle: "#slcClienteInicialTipoBusca button.dropdown-toggle",
  dropdownItem: (idx: number) =>
    `#slcClienteInicialTipoBusca a.item-tipo-menu[data-val-tipo='${idx}']`,
  search: "#slcClienteInicial",
  results: ".typeahead-result .typeahead-list li a[data-nome]",
  noResults: ".typeahead-result .typeahead-list li a",
  date: "#dataComandaInicial",
  numero: "#numeroDaComandaInicial",
  submit: "#btnAbrir",
  dialog: ".appriseOuter .appriseInner",
  dialogOk: ".appriseOuter button",
} as const;

export type OpenComandaResult =
  | { ok: true; clienteNome: string; numero: string; data: string; avecComandaId: string | null }
  | {
      ok: false;
      reason:
        | "session_expired"
        | "client_not_found"
        | "already_open"
        | "rejected"
        | "invalid_date"
        | "timeout";
      message: string;
    };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Escolhe o campo de busca na ordem de prioridade: codigo, cpf, phone, email. */
export function pickSearchField(input: {
  codigo?: string | undefined;
  cpf?: string | undefined;
  phone?: string | undefined;
  email?: string | undefined;
}): { type: SearchType; value: string } | null {
  if (input.codigo) return { type: "codigo", value: input.codigo };
  if (input.cpf) return { type: "cpf", value: input.cpf.replace(/\D/g, "") };
  if (input.phone) return { type: "phone", value: input.phone.replace(/\D/g, "") };
  if (input.email) return { type: "email", value: input.email };
  return null;
}

/** Data de hoje (dd/mm/aaaa) no fuso de Sao Paulo. */
export function todayBr(): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date());
}

/** Aceita aaaa-mm-dd ou dd/mm/aaaa e devolve dd/mm/aaaa (ou null se invalida). */
export function normalizeDate(input: string | undefined): string | null {
  if (!input) return todayBr();
  let d: number, m: number, y: number;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(input);
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (br) [d, m, y] = [Number(br[1]), Number(br[2]), Number(br[3])];
  else return null;
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return null;
  }
  return `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}/${y}`;
}

/** Espera o elemento parar de animar (modal desliza de cima) e ficar dentro da tela. */
async function waitStable(page: Page, selector: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const handle = await page.$(selector);
    const box = handle ? await handle.boundingBox() : null;
    if (box && box.y >= 0) {
      const key = `${Math.round(box.x)}:${Math.round(box.y)}`;
      if (key === last) return;
      last = key;
    }
    await sleep(250);
  }
}

async function readDialog(page: Page): Promise<string | null> {
  try {
    return await page.evaluate((sel) => {
      const el = document.querySelector(sel.dialog) as HTMLElement | null;
      if (!el || el.offsetParent === null) return null;
      let text = (el.textContent ?? "").trim();
      const buttons = document.querySelectorAll(sel.dialogOk);
      for (const btn of buttons) {
        const label = (btn.textContent ?? "").trim();
        if (label && text.endsWith(label)) text = text.slice(0, -label.length).trim();
      }
      for (const btn of buttons) {
        const label = (btn.textContent ?? "").trim();
        if (label && text.endsWith(label)) text = text.slice(0, -label.length).trim();
      }
      return text || null;
    }, SEL);
  } catch {
    return null;
  }
}

/** Fecha o dialogo sem confirmar nada: "Nao"/"Cancelar" se existir, senao "Ok". */
async function dismissDialog(page: Page): Promise<void> {
  const buttons = await page.$$(SEL.dialogOk);
  let fallback: ElementHandle<Element> | null = null;
  for (const btn of buttons) {
    const label = ((await btn.evaluate((el) => el.textContent ?? "")) as string).trim();
    if (/^(n[aã]o|cancelar|fechar)$/i.test(label)) {
      await btn.click().catch(() => undefined);
      return;
    }
    if (/^ok$/i.test(label)) fallback = btn;
  }
  if (fallback) await fallback.click().catch(() => undefined);
}

function dialogReason(message: string): "already_open" | "rejected" {
  return /j[aá] tem uma comanda em aberto/i.test(message) ? "already_open" : "rejected";
}

/** Sugestao automatica de numero: maior "Nº000X" da lista de comandas abertas + 1. */
async function nextNumero(page: Page): Promise<string> {
  const max = await page.evaluate(() => {
    let best = 0;
    const cells = document.querySelectorAll("table tbody tr td:first-child");
    for (const cell of cells) {
      const m = /N[ºo°]\s*(\d+)/i.exec(cell.textContent ?? "");
      if (m && Number(m[1]) > best) best = Number(m[1]);
    }
    return best;
  });
  return String(max + 1);
}

async function noResultsShown(page: Page): Promise<boolean> {
  const handles = await page.$$(SEL.noResults);
  for (const handle of handles) {
    if (!(await handle.boundingBox())) continue;
    const text = await handle.evaluate((el) => el.textContent ?? "");
    if (/nenhum cliente/i.test(text)) return true;
  }
  return false;
}

async function firstVisibleResult(page: Page): Promise<ElementHandle<Element> | null> {
  const handles = await page.$$(SEL.results);
  for (const handle of handles) {
    if (await handle.boundingBox()) return handle;
  }
  return null;
}

/**
 * Abre uma comanda em https://admin.avec.beauty/admin/financeiro:
 * ABRIR COMANDA -> tipo de busca no dropdown -> cliente -> data -> numero -> Abrir.
 * Atencao: o botao Abrir grava a comanda no servidor (POST /admin/financeiro/comanda/grava).
 */
export async function openComanda(
  page: Page,
  input: { type: SearchType; value: string; data: string; numero?: string | undefined },
): Promise<OpenComandaResult> {
  const timeout = config.LOGIN_TIMEOUT_MS;

  await page.goto(`${config.AVEC_ADMIN_BASE}/admin/financeiro`, {
    waitUntil: "domcontentloaded",
    timeout,
  });
  try {
    await page.waitForSelector(SEL.openButton, { visible: true, timeout: 20_000 });
  } catch {
    return {
      ok: false,
      reason: "session_expired",
      message: "Nao foi possivel abrir o Financeiro; a sessao pode ter expirado. Faca login novamente.",
    };
  }
  await page.click(SEL.openButton);
  await page.waitForSelector(SEL.search, { visible: true, timeout: 15_000 });

  // Tipo de busca
  await waitStable(page, SEL.dropdownToggle);
  await page.click(SEL.dropdownToggle);
  await page.waitForSelector(SEL.dropdownItem(SEARCH_TYPE_INDEX[input.type]), {
    visible: true,
    timeout: 5_000,
  });
  await page.click(SEL.dropdownItem(SEARCH_TYPE_INDEX[input.type]));

  // Cliente
  await page.click(SEL.search);
  await page.type(SEL.search, input.value, { delay: 90 });
  let result: ElementHandle<Element> | null = null;
  let noResultsSince: number | null = null;
  const searchDeadline = Date.now() + 12_000;
  while (!result && Date.now() < searchDeadline) {
    await sleep(400);
    result = await firstVisibleResult(page);
    if (result) break;
    // "Nenhum cliente encontrado" tambem aparece durante a digitacao (consultas parciais);
    // so vale se persistir por alguns segundos sem resultado.
    if (await noResultsShown(page)) {
      noResultsSince ??= Date.now();
      if (Date.now() - noResultsSince >= 4_000) break;
    } else {
      noResultsSince = null;
    }
  }
  if (!result) {
    return {
      ok: false,
      reason: "client_not_found",
      message: `Nenhum cliente encontrado por ${input.type} "${input.value}"`,
    };
  }
  await result.click();
  await sleep(800);
  const clienteNome = await page.$eval(SEL.search, (el) => (el as HTMLInputElement).value.trim());
  const clienteId = await page.$eval(SEL.search, (el) => el.getAttribute("data-id") ?? "0");
  if (!clienteNome || clienteId === "0") {
    return { ok: false, reason: "client_not_found", message: "Nao foi possivel selecionar o cliente" };
  }

  // Data
  const currentDate = await page.$eval(SEL.date, (el) => (el as HTMLInputElement).value.trim());
  if (currentDate !== input.data) {
    // Campo mascarado (datetimepicker): digitar fica errático; seta o valor e dispara os eventos
    await page.$eval(
      SEL.date,
      (el, value) => {
        const input = el as HTMLInputElement;
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new Event("blur", { bubbles: true }));
      },
      input.data,
    );
    const typed = await page.$eval(SEL.date, (el) => (el as HTMLInputElement).value.trim());
    if (typed !== input.data) {
      return { ok: false, reason: "invalid_date", message: `A AVEC nao aceitou a data ${input.data}` };
    }
  }

  // Numero (obrigatorio na tela da AVEC; sem informar, usa o proximo da lista)
  const numero = input.numero ?? (await nextNumero(page));
  await page.click(SEL.numero);
  await page.type(SEL.numero, numero, { delay: 50 });

  // Abrir: grava a comanda no servidor
  const grava = page
    .waitForResponse(
      (r) => r.request().method() === "POST" && r.url().includes("/admin/financeiro/comanda/grava"),
      { timeout: 20_000 },
    )
    .catch(() => null);
  await page.click(SEL.submit);

  // Validacao local (dialogo) ou resposta do servidor, o que vier primeiro
  const outcome = await Promise.race([
    grava.then((r) => ({ kind: "response" as const, response: r })),
    (async () => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        await sleep(300);
        const message = await readDialog(page);
        if (message) return { kind: "dialog" as const, message };
      }
      return { kind: "none" as const };
    })(),
  ]);

  if (outcome.kind === "dialog") {
    await dismissDialog(page);
    return { ok: false, reason: dialogReason(outcome.message), message: outcome.message };
  }
  if (outcome.kind === "none" || !outcome.response) {
    return { ok: false, reason: "timeout", message: "A AVEC nao respondeu ao abrir a comanda" };
  }

  const response = outcome.response;
  const body = await response.text().catch(() => "");
  logger.info({ status: response.status(), body: body.slice(0, 300) }, "comanda_grava_response");
  if (response.status() >= 400) {
    return { ok: false, reason: "rejected", message: `A AVEC respondeu HTTP ${response.status()}` };
  }

  // Erros do servidor costumam aparecer no mesmo dialogo apos a resposta
  await sleep(1200);
  const lateMessage = await readDialog(page);
  if (lateMessage) {
    await dismissDialog(page);
    return { ok: false, reason: dialogReason(lateMessage), message: lateMessage };
  }

  let avecComandaId: string | null = null;
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    if (json.success === false || json.erro || json.error) {
      return {
        ok: false,
        reason: "rejected",
        message: String(json.message ?? json.msg ?? json.erro ?? json.error ?? "Comanda recusada"),
      };
    }
    const id = json.id ?? json.comanda_id ?? json.idComanda;
    if (typeof id === "string" || typeof id === "number") avecComandaId = String(id);
  } catch {
    /* resposta nao-JSON */
  }

  return { ok: true, clienteNome, numero, data: input.data, avecComandaId };
}
