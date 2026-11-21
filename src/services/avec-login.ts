import type { Page } from "puppeteer";
import { config } from "../config.js";

/**
 * A AVEC tem dois layouts de login em /{slug}/admin:
 *  - classic: formulario server-side (#formEmail / #formSenha), erro em .help-block
 *  - mfe:     micro-frontend React (Cognito/Amplify), erro em toast "Algo deu errado ..."
 * Quando logado, a pagina expoe o id do salao em #salaoId.
 */
const SEL = {
  classicEmail: "#formEmail",
  classicPassword: "#formSenha",
  classicSubmit: "form[name='formeLogin'] button[type='submit']",
  classicError: ".container-error .help-block",
  mfeEmail: "input[type='email'][name='email']",
  mfePassword: "input[type='password']",
  mfeSubmit: "button::-p-text(Acessar conta)",
} as const;

export type LoginFailure =
  | { ok: false; reason: "invalid_credentials"; message: string }
  | { ok: false; reason: "blocked"; message: string }
  | { ok: false; reason: "unexpected_page"; message: string };

export type LoginResult =
  | { ok: true; alreadyLoggedIn: boolean; salaoId: number | null; url: string }
  | LoginFailure;

type PageKind = "classic" | "mfe" | "logged" | "unknown";
interface PageState {
  kind: PageKind;
  salaoId: number | null;
}

export const adminUrl = (slug: string) => `${config.AVEC_ADMIN_BASE}/${slug}/admin`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function detectState(page: Page): Promise<PageState> {
  try {
    return await page.evaluate((sel) => {
      const raw = (document.getElementById("salaoId") as HTMLInputElement | null)?.value ?? "";
      const salaoId = /^\d+$/.test(raw) ? Number(raw) : null;
      if (salaoId !== null) return { kind: "logged" as const, salaoId };
      if (document.querySelector(sel.classicEmail)) return { kind: "classic" as const, salaoId };
      if (document.querySelector(sel.mfeEmail)) return { kind: "mfe" as const, salaoId };
      return { kind: "unknown" as const, salaoId };
    }, SEL);
  } catch {
    // contexto destruido durante navegacao
    return { kind: "unknown", salaoId: null };
  }
}

/** Espera a pagina assumir um estado conhecido (o MFE renderiza de forma assincrona). */
async function waitForState(page: Page, timeoutMs: number): Promise<PageState> {
  const deadline = Date.now() + timeoutMs;
  let state = await detectState(page);
  while (state.kind === "unknown" && Date.now() < deadline) {
    await sleep(300);
    state = await detectState(page);
  }
  return state;
}

/** Verifica se a aba continua autenticada em /{slug}/admin. */
export async function isLoggedIn(page: Page, slug: string): Promise<PageState> {
  const res = await page.goto(adminUrl(slug), {
    waitUntil: "domcontentloaded",
    timeout: config.LOGIN_TIMEOUT_MS,
  });
  if (!res || res.status() >= 400) return { kind: "unknown", salaoId: null };
  return waitForState(page, 15_000);
}

export interface ClientInfo {
  salaoId: number;
  name: string | null;
}

/**
 * Le "ID Cliente: 107521 - NOME" do rodape (p.footer-avec-cliente-id) da area logada.
 * Se o rodape nao aparecer a tempo, usa o #salaoId (`fallbackSalaoId`).
 */
export async function readClientInfo(
  page: Page,
  fallbackSalaoId: number | null,
  timeoutMs = 8_000,
): Promise<ClientInfo | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const found = await page.evaluate(() => {
        const text =
          document.querySelector(".footer-avec-cliente-id")?.textContent ?? document.body.innerText;
        const m = text.match(/ID Cliente:\s*(\d+)(?:\s*-\s*([^\n]+))?/);
        return m ? { salaoId: Number(m[1]), name: (m[2] ?? "").trim() || null } : null;
      });
      if (found) return found;
    } catch {
      /* navegando */
    }
    await sleep(400);
  }
  return fallbackSalaoId !== null ? { salaoId: fallbackSalaoId, name: null } : null;
}

async function readMfeError(page: Page): Promise<string | null> {
  try {
    return await page.evaluate(() => {
      const m = document.body.innerText.match(/Algo deu errado\s*\n*\s*([^\n]+)/);
      return m ? (m[1] ?? "").trim() : null;
    });
  } catch {
    return null;
  }
}

async function loginMfe(page: Page, email: string, password: string): Promise<LoginResult> {
  const timeout = config.LOGIN_TIMEOUT_MS;
  await page.type(SEL.mfeEmail, email, { delay: 35 });
  await page.type(SEL.mfePassword, password, { delay: 35 });
  await page.locator(SEL.mfeSubmit).setTimeout(10_000).click();

  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await sleep(400);
    const state = await detectState(page);
    if (state.kind === "logged") {
      return { ok: true, alreadyLoggedIn: false, salaoId: state.salaoId, url: page.url() };
    }
    const error = await readMfeError(page);
    if (error) return { ok: false, reason: "invalid_credentials", message: error };
  }
  return {
    ok: false,
    reason: "unexpected_page",
    message: "Tempo esgotado aguardando a AVEC concluir o login",
  };
}

async function loginClassic(page: Page, email: string, password: string): Promise<LoginResult> {
  const timeout = config.LOGIN_TIMEOUT_MS;
  await page.type(SEL.classicEmail, email, { delay: 35 });
  await page.type(SEL.classicPassword, password, { delay: 35 });

  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout }).catch(() => null),
    page.click(SEL.classicSubmit),
  ]);

  const state = await waitForState(page, 15_000);
  if (state.kind === "logged") {
    return { ok: true, alreadyLoggedIn: false, salaoId: state.salaoId, url: page.url() };
  }
  if (state.kind === "classic") {
    // O formulario e server-side: erro => a mesma pagina volta com .help-block
    const message =
      (await page
        .$eval(SEL.classicError, (el) => (el.textContent ?? "").trim())
        .catch(() => "")) || "E-mail ou senha incorretos.";
    return { ok: false, reason: "invalid_credentials", message };
  }
  return {
    ok: false,
    reason: "unexpected_page",
    message: "A AVEC nao confirmou o login (pagina inesperada)",
  };
}

/** Faz login em https://admin.avec.beauty/{slug}/admin simulando um usuario no navegador. */
export async function loginToAvec(
  page: Page,
  input: { slug: string; email: string; password: string },
): Promise<LoginResult> {
  const res = await page.goto(adminUrl(input.slug), {
    waitUntil: "domcontentloaded",
    timeout: config.LOGIN_TIMEOUT_MS,
  });
  const status = res?.status() ?? 0;
  if (status === 403) {
    return {
      ok: false,
      reason: "blocked",
      message: "Acesso bloqueado pela AVEC (403). O IP da sessao pode ter sido barrado.",
    };
  }
  if (status >= 400) {
    return { ok: false, reason: "blocked", message: `AVEC respondeu HTTP ${status}` };
  }

  const state = await waitForState(page, 20_000);
  switch (state.kind) {
    case "logged":
      return { ok: true, alreadyLoggedIn: true, salaoId: state.salaoId, url: page.url() };
    case "classic":
      return loginClassic(page, input.email, input.password);
    case "mfe":
      return loginMfe(page, input.email, input.password);
    default:
      return {
        ok: false,
        reason: "unexpected_page",
        message: "Tela de login da AVEC nao reconhecida",
      };
  }
}
