import type { HTTPResponse as PupResponse, Page } from "puppeteer";
import { config } from "../config.js";
import { logger } from "../logger.js";

/** Tipos do dropdown da busca em /admin/clientes (data-val-tipo). */
export type ClienteSearchType = "nome" | "email" | "celular" | "cpf" | "codigo";

const SEARCH_TYPE_INDEX: Record<ClienteSearchType, number> = {
  nome: 0,
  email: 1,
  celular: 2, // "Telefone (Fixo ou Celular)"
  cpf: 3,
  codigo: 4,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Cliente no formato `salonClient` da API antiga. */
export interface Cliente {
  id: number;
  salao_id: number;
  codigo: number | null;
  nome: string;
  email: string | null;
  foto?: string;
  datanasc: string | null;
  telefone: string;
  celular: string;
  operadora: string;
  rg: string;
  cpf: string;
  profissao: string;
  como_conheceu: string;
  sexo: string;
  endereco: string;
  numero: number;
  bairro: string;
  cod_cidade: string;
  cidade: string;
  estado: string;
  obs: string;
  cep: string;
  email_mkt: number;
  emissao_nota: boolean;
  datacad: string | null;
  UA: string | null;
  agendamento_online: number;
  complemento: string;
  responsavel_ua?: string;
  ddi_celular: number;
  ddi_telefone: number;
  aceita_atendimento_ia: number;
  aceita_comunicacao_whatsapp: number;
}

export type SearchClientesResult =
  | { ok: true; total: number; clientes: Partial<Cliente>[] }
  | { ok: false; reason: "session_expired" | "timeout"; message: string };

interface ListRow {
  codigo: string;
  nome: string;
  foto?: string;
  contato: string;
}

/** Resumo de um cliente lido do modal de edicao (aba Cadastro). */
interface ModalData {
  id: string | null;
  cliente_id: string;
  codigo: string;
  nome: string;
  email: string;
  datanasc: string;
  ddi_celular: string;
  ddi_telefone: string;
  celularRaw: string;
  telefoneRaw: string;
  operadora: string;
  sexo: string;
  cpfRaw: string;
  rg: string;
  cep: string;
  estado: string;
  cidade: string;
  cod_cidade: string;
  bairro: string;
  endereco: string;
  numero: string;
  complemento: string;
  obs: string;
  como_conheceu: string;
  profissao: string;
  email_mkt: boolean;
  agendamento_online: boolean;
  emissao_nota: boolean;
  aceita_atendimento_ia: boolean;
  aceita_comunicacao_whatsapp: boolean;
  footer: string;
}

const clean = (v: string): string => v.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();

const toInt = (v: string | null | undefined, fallback = 0): number => {
  const n = Number(String(v ?? "").replace(/\D/g, ""));
  return Number.isFinite(n) && String(v ?? "").trim() !== "" ? n : fallback;
};

/** dd/mm/aaaa -> aaaa-mm-dd */
function isoDate(br: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(br.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/** "18/10/2026 13:41" -> "2026-10-18 13:41:00" */
function isoDateTime(br: string | undefined): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/.exec((br ?? "").trim());
  return m ? `${m[3]}-${m[2]}-${m[1]} ${m[4]}:${m[5]}:00` : null;
}

function fromModal(m: ModalData, row: ListRow | null, salaoId: number): Cliente {
  const cad = /Data de cadastro:\s*([0-9/]+\s+[0-9:]+)/i.exec(m.footer)?.[1];
  const mod = /[ÚU]ltima modifica[çc][aã]o:\s*([0-9/]+\s+[0-9:]+)(?:\s+por\s+(.+))?/i.exec(m.footer);
  return {
    id: Number(m.id),
    salao_id: salaoId,
    codigo: m.codigo ? toInt(m.codigo) : row ? toInt(row.codigo) : null,
    nome: clean(m.nome || row?.nome || ""),
    email: m.email.trim() || null,
    ...(row?.foto ? { foto: row.foto } : {}),
    datanasc: isoDate(m.datanasc),
    telefone: m.telefoneRaw,
    celular: m.celularRaw,
    operadora: /^op\.?$/i.test(m.operadora.trim()) ? "" : m.operadora,
    rg: m.rg,
    cpf: m.cpfRaw,
    profissao: m.profissao,
    como_conheceu: m.como_conheceu,
    sexo: m.sexo,
    endereco: m.endereco,
    numero: toInt(m.numero),
    bairro: m.bairro,
    cod_cidade: /^selecione/i.test(m.cod_cidade) ? "" : m.cod_cidade,
    cidade: m.cidade,
    estado: /^selecione/i.test(m.estado) ? "" : m.estado,
    obs: m.obs,
    cep: m.cep,
    email_mkt: m.email_mkt ? 1 : 0,
    emissao_nota: m.emissao_nota,
    datacad: isoDateTime(cad),
    UA: isoDateTime(mod?.[1]),
    agendamento_online: m.agendamento_online ? 1 : 0,
    complemento: m.complemento,
    ...(mod?.[2]?.trim() ? { responsavel_ua: mod[2].trim() } : {}),
    ddi_celular: toInt(m.ddi_celular, 55),
    ddi_telefone: toInt(m.ddi_telefone, 55),
    aceita_atendimento_ia: m.aceita_atendimento_ia ? 1 : 0,
    aceita_comunicacao_whatsapp: m.aceita_comunicacao_whatsapp ? 1 : 0,
  };
}

/** So com os dados da lista (quando o modal nao abre): devolve apenas o que se sabe. */
function fromRow(row: ListRow, salaoId: number): Partial<Cliente> {
  const cel = /Cel:\s*([^\n]*)/i.exec(row.contato)?.[1]?.replace(/\D/g, "") ?? "";
  const email = /E-mail:\s*(\S+)/i.exec(row.contato)?.[1] ?? "";
  return {
    salao_id: salaoId,
    codigo: toInt(row.codigo),
    nome: clean(row.nome),
    email: email || null,
    ...(cel ? { celular: cel } : {}),
    ...(row.foto ? { foto: row.foto } : {}),
  };
}

const LIST_ROWS_JS = `(() => {
  const rows = [...document.querySelectorAll('#tableFilter tbody tr')];
  return rows
    .map((tr) => {
      const tds = tr.querySelectorAll('td');
      if (tds.length < 3) return null;
      const img = tds[1].querySelector('img');
      const src = img ? img.getAttribute('src') : null;
      return {
        codigo: (tds[0].innerText || '').trim(),
        nome: (tds[1].innerText || '').replace(/\\s+/g, ' ').trim(),
        foto: src && !/sem-imagem/i.test(src) ? src : null,
        contato: (tds[2].innerText || '').trim(),
      };
    })
    .filter(Boolean);
})()`;

const MODAL_JS = `(() => {
  const m = [...document.querySelectorAll('.modal.popupCli')].find((e) => e.offsetWidth > 0);
  if (!m) return null;
  const val = (sel) => { const e = m.querySelector(sel); return e ? (e.value || '') : ''; };
  const sel = (sel) => { const e = m.querySelector(sel); return e && e.selectedOptions[0] ? (e.selectedOptions[0].value || '') : ''; };
  const chk = (sel) => { const e = m.querySelector(sel); return !!(e && e.checked); };
  const numericId = [...m.querySelectorAll('input[name="id"]')].map((e) => e.value).find((v) => /^\\d+$/.test(v)) || null;
  const sexo = m.querySelector('input[name="sexo"]:checked');
  const nome = val('#nome');
  if (!nome) return null;
  return {
    id: numericId,
    cliente_id: val('input[name="cliente_id"]'),
    codigo: val('#codigo'),
    nome: nome,
    email: val('#email'),
    datanasc: val('#datanasc'),
    ddi_celular: val('#ddi_celular'),
    ddi_telefone: val('#ddi_telefone'),
    celularRaw: val('input[name="celularRaw"]'),
    telefoneRaw: val('input[name="telefoneRaw"]'),
    operadora: sel('select[name="operadora"]'),
    sexo: sexo ? sexo.value : '',
    cpfRaw: val('input[name="cpfRaw"]'),
    rg: val('#rg'),
    cep: val('#cep'),
    estado: sel('#estado'),
    cidade: val('#cidade'),
    cod_cidade: sel('#cod_cidade'),
    bairro: val('#bairro'),
    endereco: val('#endereco'),
    numero: val('#numero'),
    complemento: val('#complementoGroup'),
    obs: val('textarea[name="obs"]'),
    como_conheceu: val('#como_conheceu'),
    profissao: val('#profissao'),
    email_mkt: chk('#email_mkt'),
    agendamento_online: chk('#agendamento_online'),
    emissao_nota: chk('#emissao_nota'),
    aceita_atendimento_ia: chk('#aceita_atendimento_ia'),
    aceita_comunicacao_whatsapp: chk('#aceita_comunicacao_whatsapp'),
    footer: ((m.querySelector('.modal-footer') || {}).innerText || ''),
  };
})()`;

const CLOSE_MODAL_JS = `(() => {
  const m = document.querySelector('.modal.popupCli');
  if (!m) return;
  const b = m.querySelector('[data-dismiss="modal"]');
  if (b) b.click();
})()`;

const FORCE_CLOSE_JS = `(() => {
  if (window.jQuery) { try { window.jQuery('.modal.popupCli').modal('hide'); } catch (e) {} }
  document.querySelectorAll('.modal.popupCli, .modal-backdrop').forEach((e) => e.remove());
  document.body.classList.remove('modal-open');
})()`;

async function modalVisible(page: Page): Promise<boolean> {
  return (await page.evaluate(`!![...document.querySelectorAll('.modal.popupCli')].find((e) => e.offsetWidth > 0)`)) as boolean;
}

async function closeModal(page: Page): Promise<void> {
  await page.evaluate(CLOSE_MODAL_JS).catch(() => undefined);
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && (await modalVisible(page))) await sleep(200);
  if (await modalVisible(page)) await page.evaluate(FORCE_CLOSE_JS).catch(() => undefined);
  else await page.evaluate(`document.querySelectorAll('.modal-backdrop').forEach((e) => e.remove())`).catch(() => undefined);
}

/** Abre o lapis da linha `index` e le o modal. Null se nao abrir a tempo. */
async function readModal(page: Page, index: number): Promise<ModalData | null> {
  const clicked = await page.evaluate(
    `(() => {
      const tr = document.querySelectorAll('#tableFilter tbody tr')[${index}];
      const a = tr && tr.querySelector('td:last-child a.btn:not(.btn-danger)');
      if (!a) return false;
      a.click();
      return true;
    })()`,
  );
  if (!clicked) return null;
  const deadline = Date.now() + 20_000;
  let data: ModalData | null = null;
  while (Date.now() < deadline) {
    await sleep(500);
    data = (await page.evaluate(MODAL_JS)) as ModalData | null;
    // o rodape (datas) e o id numerico chegam junto com o formulario; espera os dois
    if (data && data.id && data.footer) break;
    data = null;
  }
  await closeModal(page);
  return data;
}

/**
 * Busca clientes em https://admin.avec.beauty/admin/clientes pela barra de busca
 * (tipos: Nome, E-mail, Telefone, CPF, Codigo de Cadastro) e le o cadastro completo de
 * cada resultado no modal de edicao. Somente leitura.
 */
export async function searchClientes(
  page: Page,
  input: { type: ClienteSearchType; value: string; limit: number; salaoId: number },
): Promise<SearchClientesResult> {
  const timeout = config.LOGIN_TIMEOUT_MS;
  const typeIdx = SEARCH_TYPE_INDEX[input.type];

  await page.goto(`${config.AVEC_ADMIN_BASE}/admin/clientes`, { waitUntil: "domcontentloaded", timeout });
  try {
    await page.waitForSelector("#slcCliente", { visible: true, timeout: 20_000 });
    await page.waitForSelector("#tableFilter tbody tr", { timeout: 20_000 });
  } catch {
    return {
      ok: false,
      reason: "session_expired",
      message: "Nao foi possivel abrir a lista de clientes; a sessao pode ter expirado. Faca login novamente.",
    };
  }
  await sleep(600);

  // Quantidade por pagina (10/25/50/100/500) suficiente para o limite pedido
  const wanted = [10, 25, 50, 100, 500].find((n) => n >= input.limit) ?? 500;
  if (wanted !== 10) {
    await page
      .select('select[name="tableFilter_length"]', String(wanted))
      .catch(() => undefined);
    await sleep(1_500);
  }

  // Tipo de busca (dropdown)
  await page.evaluate(`document.querySelector('#slcClienteInicialTipoBusca button.dropdown-toggle').click()`);
  await sleep(300);
  await page.evaluate(
    `document.querySelector("#slcClienteInicialTipoBusca a.item-tipo-menu[data-val-tipo='${typeIdx}']").click()`,
  );
  await sleep(500);

  // Resposta do DataTables (/admin/clientes/lista) para esta busca
  const wantedText = input.value;
  const digits = (s: string) => s.replace(/\D/g, "");
  const sameValue = (got: string) =>
    input.type === "celular" || input.type === "cpf" || input.type === "codigo"
      ? digits(got) === digits(wantedText)
      : got.trim().toLowerCase() === wantedText.trim().toLowerCase();

  let matched: { recordsFiltered: number } | null = null;
  const onResponse = async (res: PupResponse): Promise<void> => {
    const url = res.url();
    if (!url.includes("/admin/clientes/lista")) return;
    try {
      const u = new URL(url);
      if (u.searchParams.get("tipoBusca") !== String(typeIdx)) return;
      if (!sameValue(u.searchParams.get("textoBusca") ?? "")) return;
      const json = (await res.json()) as { recordsFiltered?: string | number };
      matched = { recordsFiltered: Number(json.recordsFiltered ?? 0) };
    } catch {
      /* ignora respostas ilegiveis */
    }
  };
  page.on("response", onResponse);

  try {
    // Campo mascarado: digitar embaralha o CPF; seta o valor e dispara os eventos da busca
    await page.evaluate(
      `(() => {
        const i = document.querySelector('#slcCliente');
        i.focus();
        i.value = ${JSON.stringify(input.value)};
        for (const t of ['input', 'keydown', 'keyup']) {
          i.dispatchEvent(new KeyboardEvent(t, { bubbles: true, key: '0' }));
        }
      })()`,
    );

    const deadline = Date.now() + 25_000;
    while (!matched && Date.now() < deadline) await sleep(300);
    if (!matched) {
      return { ok: false, reason: "timeout", message: "A plataforma nao respondeu a busca de clientes" };
    }
    await sleep(800); // DataTables renderiza as linhas
  } finally {
    page.off("response", onResponse);
  }

  const total = (matched as { recordsFiltered: number } | null)?.recordsFiltered ?? 0;
  const rows = ((await page.evaluate(LIST_ROWS_JS)) as ListRow[]).slice(0, input.limit);

  const clientes: Partial<Cliente>[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const modal = await readModal(page, i);
    if (modal) clientes.push(fromModal(modal, row, input.salaoId));
    else {
      logger.warn({ codigo: row.codigo }, "cliente_modal_nao_abriu");
      clientes.push(fromRow(row, input.salaoId));
    }
  }
  return { ok: true, total, clientes };
}
