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

| Metodo | Rota          | Descricao                                                        |
| ------ | ------------- | ---------------------------------------------------------------- |
| GET    | `/health`     | Status do servico e do banco                                     |
| POST   | `/auth/login` | Login na AVEC (`admin.avec.beauty/{slug}/admin`) com IP por sessao |
| GET    | `/relatorios/{codigo}` | Consulta um relatorio da AVEC (`/admin/relatorio/{codigo}`) e devolve as linhas |
| GET    | `/comandas`   | Consulta uma comanda por data e numero (itens e pagamentos)      |
| POST   | `/comandas`   | Abre uma comanda no Financeiro da AVEC (usa a sessao do login)   |
| GET    | `/docs`       | Swagger UI                                                       |

### `POST /auth/login`

Body:

```json
{ "email": "gestor@salao.com", "password": "minha-senha", "slug": "avec" }
```

Informe `slug`, `salao_id` ou ambos. Com apenas `salao_id` (numero ou string numerica), o slug e buscado em `customers_bridget`; se o salao_id nao estiver cadastrado, responde 404 `salao_not_found` (no primeiro acesso de um cliente novo, mande o `slug`). O `salao_id` real e lido da propria AVEC apos o login e gravado na tabela.

```json
{ "email": "gestor@salao.com", "password": "minha-senha", "salao_id": 107521 }
```

Exemplo:

```bash
curl -X POST http://localhost:3100/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"gestor@salao.com","password":"minha-senha","slug":"avec"}'
```

Resposta `200`:

```json
{
  "success": true,
  "slug": "avec",
  "salao_id": 34103,
  "sessionId": "9f2c1a7b3d4e5f60",
  "reused": false,
  "proxyIp": "187.12.34.56"
}
```

| Status | `error`               | Quando                                                     |
| ------ | --------------------- | ---------------------------------------------------------- |
| 400    | `invalid_params`      | email, password ou slug invalidos                          |
| 400    | `slug_salao_mismatch` | slug e salao_id informados nao sao do mesmo cliente        |
| 404    | `salao_not_found`     | So salao_id, e ele nao existe em `customers_bridget`       |
| 403    | `customer_inactive`   | `active = false` em `customers_bridget`                    |
| 401    | `invalid_credentials` | E-mail ou senha incorretos                                 |
| 409    | `session_busy`        | Ja existe uma operacao em andamento para o slug            |
| 502    | `bridge_unavailable`  | Falha ao criar a zone na Bright Data ou limite de pontes   |
| 502    | `proxy_unavailable`   | Nao foi possivel obter IP pelo proxy                       |
| 502    | `blocked`             | A AVEC bloqueou o acesso (ex.: 403 pelo IP)                |
| 502    | `unexpected_page`     | Tela da AVEC nao reconhecida ou login nao concluiu a tempo |
| 502    | `browser_error`       | Falha no Chromium durante o login                          |

### `GET /relatorios/{codigo}`

Consulta um relatorio da AVEC e devolve as linhas da busca. Usa a sessao ja logada (como as demais rotas).

```bash
curl "http://localhost:3100/relatorios/0123?salao_id=107521&inicio=2026-11-01&fim=2026-11-21"
```

- Cliente: `slug` e/ou `salao_id`.
- Filtros: todo query param que nao seja `slug`/`salao_id` e um filtro do relatorio, pelo `name` do input na tela. O `0123` ("Profissionais e todas as comissoes por periodo") aceita `inicio` e `fim` (padrao da AVEC: 1o dia do mes ate hoje). Um filtro que o relatorio nao tem responde `400 invalid_filter` com a lista em `filtros_disponiveis`. Campos de data aceitam `aaaa-mm-dd` ou `dd/mm/aaaa`.
- Fluxo: abre `/admin/relatorio/{codigo}`, preenche os inputs, clica em **Buscar** (`listar()`) e le a resposta de `GET /admin/relatorios/listar?relatorio=&salao=&inicio=&fim=` (`aaData`, ja com **todas** as linhas, sem a paginacao de 10 da tabela).
- As chaves de cada linha sao os cabecalhos da tabela; os valores vem como exibidos na AVEC (strings, ex.: `"1.800,00"`), `null` quando vazio.

```json
{
  "success": true, "slug": "les-sens-experience-byd", "salao_id": 107521,
  "codigo": "0123", "titulo": "0123 - Profissionais e todas as comissoes por periodo",
  "filtros": { "inicio": "01/11/2026", "fim": "21/11/2026" },
  "totais": { "Total Faturado": "20.746,00", "Total A pagar": "8.188,13", "Valor Casa": "12.819,55" },
  "colunas": ["Profissional", "Tipo Contratacao", "Cargo", "Banco", "Agencia", "Conta", "Faturado", "Rateio Servicos", "Rateio Produtos", "Rateio Outros", "Caixinha", "Descontos", "A pagar", "Valor Casa"],
  "total": 22,
  "linhas": [
    { "Profissional": "Aline Patricia da Silva Diniz Lira", "Cargo": "Podologista", "Banco": null, "Faturado": "1.800,00", "Rateio Servicos": "811,00", "A pagar": "770,45", "Valor Casa": "989,00" }
  ]
}
```

| Status | `error` | Quando |
| ------ | ------- | ------ |
| 400 | `invalid_params` / `invalid_filter` / `invalid_value` | Codigo, cliente, filtro inexistente ou valor invalido |
| 401 | `not_logged_in` / `session_expired` | Sem sessao ou sessao caiu |
| 404 | `relatorio_not_found` / `salao_not_found` | Codigo inexistente (a AVEC responde 200 com titulo vazio) |
| 409 | `session_busy` | Outra operacao em andamento no slug |
| 422 | `relatorio_unsupported` | Relatorio sem linhas para ler (ex.: painel Metabase em iframe) |
| 502 / 504 | `browser_error` / `timeout` | Falha no Chromium / AVEC nao respondeu |

E lento (30-60s por chamada, mesmo para erro de filtro, porque a pagina e carregada antes de validar). Nem todo relatorio foi testado: so o `0123`; relatorios com outros tipos de filtro (selects, etc.) usam o mesmo mecanismo, mas vale validar cada um.

### `GET /comandas`

Consulta uma comanda por data e numero, somente leitura. Usa a sessao ja logada (como o `POST`).

```bash
curl "http://localhost:3100/comandas?salao_id=107521&numero=6&data=2026-11-21"
```

Parametros (query): `slug` e/ou `salao_id`, `numero` (obrigatorio) e `data` (`aaaa-mm-dd` ou `dd/mm/aaaa`; padrao hoje).

Fluxo: `/admin/financeiro` (abertas) -> campo **Buscar** com `NºXXXX (dd/mm/aaaa)`; so vale a linha cuja 1a coluna casa exatamente com numero e data (a busca do DataTable e aproximada). Se nao achar, `/admin/financeiro/comanda/historico` (finalizadas): filtra o periodo (1o so o dia da comanda; depois de -15 a +30 dias, limitado a hoje), clica em Buscar e usa o campo Buscar. Clica no lapis, le as abas **Itens** e **Pagamento** e fecha o modal sem salvar.

```json
{
  "success": true, "slug": "les-sens-experience-byd", "salao_id": 107521,
  "comanda": {
    "origem": "abertas", "numero": 6, "data": "21/11/2026",
    "cliente": "88888808 - Ludmila (Gerente Beyond)", "caixa": null,
    "aberta_em": "21/11/2026 12:02", "valor": 959,
    "resumo_pagamento": { "caixa": null, "saldo_cliente": 0, "total": 959, "a_cobrar": 959, "troco": -959 }
  },
  "itens": [
    { "tipo": "salao_servicos", "item": "Manicure", "profissional": "Leticia", "comissao_pct": 55,
      "quantidade": 1, "valor_unitario": 60, "desconto_pct": 0, "total": 60 }
  ],
  "pagamentos": [
    { "forma": "Cortesia", "informacao": null, "parcelas": 1, "data_cobranca": null, "valor": 110 }
  ]
}
```

- `pagamentos` vem vazio numa comanda aberta sem pagamento (a linha "Dinheiro 0,00" da tela e so um placeholder; linhas com valor 0 e sem informacao sao descartadas).
- `origem` indica onde a comanda foi achada (`abertas` ou `finalizadas`). `caixa` em abertas costuma ser `null` (nenhum caixa selecionado ainda).
- Erros: 400 `invalid_params`, 401 `not_logged_in`/`session_expired`, 404 `comanda_not_found`/`salao_not_found`, 409 `session_busy`, 502 `browser_error`.
- E lento: ~20s para abertas, ~40s para finalizadas e ~1 min quando nao existe (passa pelas 2 telas e 2 janelas de periodo), por causa do navegador atras do proxy.

### `POST /comandas`

Abre uma comanda usando a sessao ja logada do cliente (faca `POST /auth/login` antes). **Grava uma comanda real na AVEC.**

```json
{ "slug": "les-sens-experience-byd", "codigo": "88888947", "numero": "8", "data": "2026-11-21" }
```

- Cliente: `slug` e/ou `salao_id`, como no login.
- Cliente da comanda: informe `codigo`, `cpf`, `phone` ou `email`. Se vierem varios, vale a ordem **codigo, cpf, phone, email**. CPF e telefone sao enviados so com digitos.
- `data`: `aaaa-mm-dd` ou `dd/mm/aaaa`; padrao hoje (America/Sao_Paulo).
- `numero`: opcional. A tela da AVEC exige um numero, entao quando nao vem usa o maior numero da lista de comandas do Financeiro + 1 (pode colidir se houver mais comandas que a primeira pagina da tabela; nesse caso a AVEC recusa e a API responde 422).

Fluxo no navegador: `/admin/financeiro` -> ABRIR COMANDA -> dropdown de tipo (E-mail, Telefone, CPF, Codigo de Cadastro) -> busca do cliente -> data -> numero -> Abrir (`POST /admin/financeiro/comanda/grava`).

Resposta `201`: `{ "success": true, "slug": "...", "salao_id": 107521, "comanda": { "numero": "8", "data": "21/11/2026", "cliente": "Murilo", "busca": { "campo": "codigo", "valor": "88888947" }, "avec_id": null } }`

| Status | `error`                | Quando                                                    |
| ------ | ---------------------- | --------------------------------------------------------- |
| 400    | `invalid_params`       | Nenhum campo do cliente, data/numero invalidos            |
| 401    | `not_logged_in`        | Nao ha sessao aberta para o slug (chame `/auth/login`)    |
| 401    | `session_expired`      | A sessao caiu na AVEC; faca login de novo                 |
| 403    | `customer_inactive`    | `active = false`                                          |
| 404    | `client_not_found`     | Nenhum cliente achado pelo campo informado                |
| 404    | `salao_not_found`      | `salao_id` nao existe em `customers_bridget`              |
| 409    | `session_busy`         | Outra operacao em andamento no slug                       |
| 409    | `already_open`         | A AVEC avisou que o cliente ja tem comanda em aberto (nada e gravado) |
| 422    | `rejected`             | A AVEC recusou (ex.: numero ja usado); `message` traz o texto |
| 502    | `browser_error`        | Falha no Chromium                                         |
| 504    | `timeout`              | A AVEC nao respondeu ao Abrir                             |

Tabela `customers_bridget` (criada automaticamente):

| Coluna         | Descricao                                                      |
| -------------- | -------------------------------------------------------------- |
| `slug`         | Slug do cliente (unico)                                        |
| `salao_id`     | Id do salao na AVEC (preenchido no login; permite achar o slug) |
| `nome`         | Nome do cliente, lido do rodape da AVEC no login (`ID Cliente: N - NOME`) |
| `email`        | E-mail que fez o primeiro login                                |
| `brd_host`     | Host do proxy (ex.: `brd.superproxy.io`)                       |
| `brd_port`     | Porta do proxy                                                 |
| `brd_customer` | Customer id da conta Bright Data (`hl_...`)                    |
| `brd_zone`     | Zone do cliente (`<BRD_ZONE_PREFIX><slug>_<hash>`)             |
| `brd_country`  | Pais dos IPs da zone (`br` para todo cliente novo)             |
| `brd_password` | Senha da zone                                                  |
| `active`       | `1` por padrao; `0` bloqueia novos logins do cliente           |

(Alem dessas, existem `id`, `created_at` e `updated_at`.) Para bloquear um cliente: `UPDATE customers_bridget SET active = 0 WHERE slug = 'avec';`

Nome da zone: `<BRD_ZONE_PREFIX><slug sem hifens, truncado>_<hash6>` com no maximo 30 caracteres (limite da Bright Data; hifen e invalido pela API).

Fluxo de ponte: o login procura o slug na tabela; se nao existir, cria a zone via `POST /zone` na Bright Data (ISP dedicada, `BRD_ZONE_IPS` IP(s) **sempre do Brasil**: o pais e fixo no codigo, nao ha variavel), le a senha em `GET /zone/passwords` e grava a linha. **Cada zone nova gera cobranca na Bright Data**; `BRD_MAX_BRIDGES` limita quantas podem ser criadas automaticamente.

Layouts de login suportados em `/{slug}/admin`: o formulario classico (`#formEmail`, erro em `.help-block`) e o micro-frontend React/Cognito (erro em toast "Algo deu errado ..."). Considera-se logado quando `#salaoId` e preenchido.

Usando uma zone ja existente: em vez de deixar a API criar a zone, insira a linha em `customers_bridget` com `brd_zone`/`brd_password` de uma zone sua. Importante: a zone precisa ter o IP de quem acessa (esta maquina ou o servidor da API) na lista **Allowed IPs**, senao o proxy responde `407 ip_forbidden`.

IPs fora do Brasil: o ELB da AVEC (`awselb`) respondeu `403` para IPs dos EUA (Latitude.sh e RCN) com qualquer User-Agent, enquanto o acesso direto do Brasil funciona. Por isso **todo cliente novo e provisionado com IPs do Brasil** (`country=br` no `POST /zone`) e, a cada sessao nova, a API le o pais do IP de saida (`brdtest.com/myip.json`): se nao for `BR` (zone antiga, linha inserida a mao, pool errado), a sessao e recusada com `502 proxy_unavailable` e o caso fica registrado (`proxy_not_brazil` no log, `proxy_country` em `api_call_log` e `avec_response_log`). A coluna `customers_bridget.brd_country` guarda o pais da zone (`br`). Sem a regra, o bloqueio aparece como `502 blocked`.

Comportamento da sessao:

- Slug sem sessao no banco: abre um Chromium novo com IP novo e faz login.
- Slug com sessao viva e mesmo e-mail ja logado: reaproveita (`reused: true`) sem logar de novo.
- Slug com sessao viva e outro e-mail: descarta a sessao e abre outra com IP novo.
- Login com falha (401/502): a sessao e descartada para a proxima tentativa comecar com outro IP.
- A sessao expira (Chromium fechado) apos `SESSION_TTL_SECONDS` sem uso.

## Log de chamadas e bloqueios

Duas tabelas (criadas automaticamente) registram tudo para estudar quando e por que a AVEC barra acessos:

**`api_call_log`**: uma linha por chamada a `/auth/*` e `/comandas`.

| Coluna | Descricao |
| ------ | --------- |
| `call_id`, `created_at` | Id da chamada (liga com `avec_response_log`) e data/hora (ms) |
| `route` | Ex.: `POST /auth/login`, `POST /comandas` |
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

## Variaveis de ambiente

Veja `.env.example`. As principais: `PORT`, `DB_*`, `PROXY_ENABLED`, `BRD_API_KEY`, `BRD_HOST`, `BRD_PORT`, `BRD_ZONE_IPS`, `BRD_MAX_BRIDGES`, `PUPPETEER_HEADLESS`, `SESSION_TTL_SECONDS`.

## Seguranca

Senhas de login nunca sao logadas nem gravadas. As credenciais do proxy ficam apenas em `customers_bridget` (nunca nos logs). O `.env` esta no `.gitignore`.

## Scripts

- `npm run dev`: API com reload (`tsx watch`)
- `npm run build` / `npm start`: compila para `dist/` e roda
- `npm run lint`: checagem de tipos
