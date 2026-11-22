# puppeter

API Node/TypeScript que simula acessos a plataforma **AVEC** (SaaS B2B) abrindo um Chromium via Puppeteer, como se fosse um usuario no navegador.

- Uma sessao de navegador por `slug`, guardada no banco (coluna `session_data` de `customers_bridget`). Se o slug ja tem sessao aberta, ela e reaproveitada; senao uma nova e criada.
- Cada cliente (slug) tem uma **ponte** na tabela `customers_bridget`: uma zone ISP dedicada na Bright Data, criada pela API deles no primeiro login. Usamos a Bright Data direto, sem passar pelo `avec-GO-tls`. A sessao ainda carrega um `-session-<sessionId>` no username do proxy.
- Clientes com `active = false` na tabela nao conseguem novos logins (403).
- Documentacao interativa (Swagger): http://localhost:3100/docs (JSON em `/docs.json`).

## Requisitos

- Node 20+
- MySQL/MariaDB com acesso de escrita (a tabela `customers_bridget` e criada ao subir a API)
- API key da Bright Data (`BRD_API_KEY`), usada para criar uma zone por cliente

## Como rodar

Pelo `.vscode/sessions.json` (extensao Terminal Keeper), que abre um terminal para a API (`:3100`).

Ou manualmente:

```bash
cd puppeter
npm install
cp .env.example .env   # preencha DB_* e BRD_API_KEY
npm run dev
```

Para testar local sem proxy, use `PROXY_ENABLED=false` no `.env` (o Chromium sai pelo seu IP e nenhuma zone e criada).

## Rotas

Padrao de resposta (igual ao da API antiga "Mid"):

- Sucesso: `{ "code": 200, "data": { ... } }`
- Erro: `{ "code": 404, "message": "...", "file": null, "line": null, "trace": null }` (validacao traz tambem `errors: [{ path, message }]`; filtro de relatorio invalido traz `filtros_disponiveis`).
- O codigo interno do erro (`client_not_found`, `session_busy`, ...) nao vai no corpo; fica em `api_call_log.error_code`.
- **Autenticacao:** so `POST /api/auth/login` e `/health`/`/docs` sao abertos. O login devolve um JWT (HS256, `JWT_SECRET`, validade `JWT_TTL_SECONDS`, padrao 10 anos) e todas as outras rotas exigem `Authorization: Bearer <access_token>`.
- O token vale para **um salao** (o `salao_id` do caminho precisa ser o do token, senao 403) e para **a sessao aberta no login**: se a sessao for encerrada ou trocada (outro usuario fez login no mesmo salao), o token antigo da 401 e e preciso logar de novo.
- **Duracao:** nem o token (10 anos) nem a sessao (`SESSION_TTL_SECONDS=0`, sem expiracao por inatividade) tem prazo curto. O token so deixa de valer quando a sessao cai: Chromium/conexao fechada, login encerrado pela plataforma, ou restart/deploy da API. Nesses casos a rota responde 401 e basta chamar o login de novo.
- Erros de token: 401 (`Token nao informado`, `Token invalido`, `Token expirado`), 403 (`Token nao pertence a este salao`).

| Metodo | Rota                                                    | Descricao                                                         |
| ------ | ------------------------------------------------------- | ----------------------------------------------------------------- |
| GET    | `/health`                                               | Status do servico e do banco                                      |
| POST   | `/api/auth/login`                                       | Login (abre/reaproveita a sessao do salao)                        |
| GET    | `/api/auth/user-profile`                                | Usuario do token                                                  |
| GET    | `/api/mid/avec/salao/{salao_id}/comanda/{numero}?data=` | Consulta uma comanda (itens e pagamentos)                         |
| POST   | `/api/mid/avec/salao/{salao_id}/comandas`               | Abre uma comanda (grava de verdade)                               |
| GET    | `/api/mid/avec/salao/{salao_id}/relatorio/{codigo}?...` | Linhas de um relatorio; query params = filtros do relatorio       |
| GET    | `/docs`, `/docs.json`                                   | Swagger UI / OpenAPI                                              |

Convencoes herdadas da API antiga: colecao no plural (`/comandas`), item por id no singular (`/comanda/{numero}`), `salao_id` no caminho, datas `inicio`/`fim` em `dd/mm/aaaa` (tambem aceita `aaaa-mm-dd`), `celular` para telefone e busca de cliente por `chave` + `valor`.

### `POST /api/auth/login`

```json
{ "email": "gestor@salao.com", "password": "minha-senha", "slug": "meu-salao" }
```

`slug` e obrigatorio no primeiro acesso; depois basta `salao_id`. Resposta (mesmo formato da API antiga):

```json
{ "code": 200, "data": { "access_token": "eyJ0eXAi...", "token_type": "bearer", "expires_in": 315360000,
  "user": { "salao_id": 107521, "slug": "meu-salao", "nome": "MEU SALAO", "email": "gestor@salao.com" }, "reused": false } }
```

Use nas demais rotas: `Authorization: Bearer <access_token>`.

- Cria a sessao do salao ou reaproveita a existente (`reused: true`). Erros: 400 (parametros), 401 (credenciais), 403 (cliente desativado), 404 (`salao_id` sem cadastro e sem `slug`), 409 (operacao em andamento), 502 (indisponivel).
- Primeiro acesso de um slug: provisiona o IP brasileiro do cliente (regras de zona na secao de log/zonas abaixo) e grava `customers_bridget`.

### `GET /api/mid/avec/salao/{salao_id}/comanda/{numero}?data=`

```bash
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3100/api/mid/avec/salao/107521/comanda/6?data=2026-11-21"
```

```json
{ "code": 200, "data": { "comanda": { "origem": "finalizadas", "numero": 6, "data": "21/11/2026", "cliente": "...", "valor": 1600, "resumo_pagamento": { } },
  "itens": [ { "tipo": "salao_servicos", "item": "Manicure", "profissional": "Leticia", "comissao_pct": 55, "quantidade": 1, "valor_unitario": 60, "desconto_pct": 0, "total": 60 } ],
  "pagamentos": [ { "forma": "Cartao Credito", "informacao": "MasterCard", "parcelas": 1, "data_cobranca": null, "valor": 690 } ] } }
```

Procura primeiro nas comandas abertas e depois nas finalizadas; `data` padrao = hoje. 404 se nao achar. Somente leitura (20-60s).

### `POST /api/mid/avec/salao/{salao_id}/comandas`

Requer login previo. **Grava uma comanda real.**

```json
{ "chave": "celular", "valor": "(11) 91234-5678", "data": "2026-11-21", "numero": "8" }
```

Cliente por `codigo`, `cpf`, `celular` ou `email` (nessa ordem se vierem varios) ou por `chave` + `valor`. `numero` opcional (padrao: maior + 1). Resposta (200): `{ "code": 200, "data": { "comanda": { "id", "numero", "data", "cliente", "busca": { "campo", "valor" } } } }`. Erros: 404 cliente nao encontrado, 409 cliente ja com comanda aberta / operacao em andamento, 422 recusada (numero usado, data invalida), 504 tempo esgotado.

### `GET /api/mid/avec/salao/{salao_id}/relatorio/{codigo}?<filtros>`

```bash
curl -H "Authorization: Bearer $TOKEN" "http://localhost:3100/api/mid/avec/salao/107521/relatorio/0123?inicio=01/11/2026&fim=21/11/2026"
```

`data`: `{ codigo, titulo, filtros, totais, colunas, total, linhas: [ { <coluna>: <valor> } ] }`. Todas as linhas (sem paginacao); valores como exibidos (`1.800,00`). Filtro inexistente -> 400 com `filtros_disponiveis`; relatorio inexistente -> 404; relatorio em formato de painel -> 422.

## Log de chamadas e bloqueios

Duas tabelas (criadas automaticamente) registram tudo para estudar quando e por que a AVEC barra acessos:

**`api_call_log`**: uma linha por chamada a `/api/*`.

| Coluna | Descricao |
| ------ | --------- |
| `call_id`, `created_at` | Id da chamada (liga com `avec_response_log`) e data/hora (ms) |
| `route` | Ex.: `POST /api/auth/login`, `GET /api/mid/avec/salao/:salao_id/comanda/:numero` |
| `slug`, `salao_id` | Cliente |
| `http_status`, `error_code` | O que esta API devolveu (`blocked`, `invalid_credentials`, `already_open`...) |
| `duration_ms` | Duracao total (um timeout de rede aparece como `browser_error` com ~45s e `avec_requests = 0`) |
| `session_id`, `session_reused`, `proxy_ip`, `brd_zone` | Sessao, IP de saida e zone usados |
| `avec_requests`, `avec_errors`, `avec_blocks` | Quantas respostas da AVEC foram vistas, quantas >= 400 e quantas pareceram bloqueio |

**`avec_response_log`**: uma linha por resposta HTTP da AVEC vista no Chromium (documentos, XHR e fetch para `*.avec.beauty` e Cognito; sem imagens/CSS/JS). Guarda `status`, `method`, `host`, `path` (sem query string), `latency_ms`, `proxy_ip`, `brd_zone`, `session_id`, `server`, headers relevantes (`headers`: server, via, x-cache, cf-ray, retry-after...), `body_snippet` (400 primeiros caracteres das respostas >= 400) e `is_block`. Falhas de conexao pelo proxy entram com `status` nulo e o motivo em `error_text`. `is_block = 1` quando o status e 403/429 ou >= 400 vindo de WAF/ELB conhecido (`awselb`, cloudflare, cloudfront, akamai, imperva...) ou quando o proxy falha (`ERR_*PROXY*`/`TUNNEL`).

Consultas uteis:

```sql
-- bloqueios por hora e por IP de saida
SELECT DATE_FORMAT(created_at, '%Y-%m-%d %H:00') hora, proxy_ip, brd_zone, status, COUNT(*) n
  FROM avec_response_log WHERE is_block = 1
 GROUP BY hora, proxy_ip, brd_zone, status ORDER BY hora DESC;

-- taxa de bloqueio por zone/IP
SELECT brd_zone, proxy_ip, COUNT(*) total, SUM(is_block) blocks, ROUND(100*SUM(is_block)/COUNT(*),1) pct
  FROM avec_response_log GROUP BY brd_zone, proxy_ip ORDER BY pct DESC;

-- quanto tempo uma sessao/IP viveu antes do primeiro bloqueio
SELECT session_id, proxy_ip, MIN(created_at) primeira, MIN(CASE WHEN is_block THEN created_at END) primeiro_bloqueio, COUNT(*) reqs
  FROM avec_response_log GROUP BY session_id, proxy_ip;

-- amostra do que a AVEC/WAF respondeu nos bloqueios
SELECT created_at, path, status, server, headers, body_snippet FROM avec_response_log WHERE is_block = 1 ORDER BY id DESC LIMIT 20;

-- chamadas da API que falharam e o motivo
SELECT route, error_code, http_status, COUNT(*) n FROM api_call_log WHERE http_status >= 400 GROUP BY route, error_code, http_status;
```

As gravacoes sao assincronas e nao interrompem a chamada se o banco falhar. Respostas que chegam depois do fim da rota herdam IP/zone/`call_id` da ultima chamada do slug.

## Deploy (producao)

- **Onde:** VPS `187.45.255.52` (o mesmo do conectabi), servico systemd `conecta-pup`, app em `/var/www/conecta-pup`, API em `127.0.0.1:3100` atras do nginx (`pup.pontedosdados.com.br`).
- **CI/CD:** push em `main` roda `.github/workflows/deploy.yml`: SSH no servidor, `git reset --hard origin/main`, grava o `.env` a partir do secret `ENV` e executa `scripts/deploy.sh` (apt de libs do Chromium, `npm ci` + build, systemd, nginx, certbot, healthcheck).
- **Secrets do repositorio:** `SSH_HOST`, `SSH_USER`, `SSH_PRIVATE_KEY` (chave dedicada ao CI) e `ENV` (conteudo do `.env` de producao, sem `TEST_AVEC_*`).
- **HTTPS:** o certbot so roda quando o DNS de `pup.pontedosdados.com.br` ja aponta para o servidor; senao o proximo deploy tenta de novo.
- **Operacao:** `systemctl status conecta-pup`, `journalctl -u conecta-pup -f`.
- Cada deploy reinicia a API e fecha os Chromium abertos; os clientes precisam fazer login de novo.

## Variaveis de ambiente

Veja `.env.example`. As principais: `PORT`, `JWT_SECRET`, `JWT_TTL_SECONDS`, `DB_*`, `PROXY_ENABLED`, `BRD_API_KEY`, `BRD_HOST`, `BRD_PORT`, `BRD_ZONE_IPS`, `BRD_MAX_BRIDGES`, `PUPPETEER_HEADLESS`, `SESSION_TTL_SECONDS`.

## Seguranca

Senhas de login nunca sao logadas nem gravadas. As credenciais do proxy ficam apenas em `customers_bridget` (nunca nos logs). O `.env` esta no `.gitignore`.

## Scripts

- `npm run dev`: API com reload (`tsx watch`)
- `npm run build` / `npm start`: compila para `dist/` e roda
- `npm run lint`: checagem de tipos
