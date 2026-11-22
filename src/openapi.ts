import { config } from "./config.js";

const errorSchema = (example: { error: string; message: string }) => ({
  type: "object",
  required: ["error", "message"],
  properties: {
    error: { type: "string", example: example.error },
    message: { type: "string", example: example.message },
  },
});

export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "Conecta API",
    version: "0.1.0",
    description:
      "API de integracao para consulta de comandas e relatorios e abertura de comandas. " +
      "Faca `POST /auth/login` primeiro; as demais rotas reaproveitam a sessao aberta do cliente.",
  },
  servers: [{ url: "/" }],
  tags: [
    { name: "Auth", description: "Autenticacao" },
    { name: "Comandas", description: "Comandas" },
    { name: "Relatorios", description: "Relatorios" },
    { name: "Health", description: "Status do servico" },
  ],
  paths: {
    "/health": {
      get: {
        tags: ["Health"],
        summary: "Healthcheck",
        responses: {
          "200": {
            description: "Servico no ar",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", example: "ok" },
                    db: { type: "string", example: "ok" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/comandas": {
      get: {
        tags: ["Comandas"],
        summary: "Consultar comanda (itens e pagamentos)",
        description:
          "Usa a sessao ja logada do cliente. Procura a comanda pela data e numero entre as abertas e, " +
          "se nao achar, entre as finalizadas, e devolve os itens e os pagamentos. Somente leitura. " +
          "A consulta pode levar dezenas de segundos.",
        parameters: [
          { name: "slug", in: "query", schema: { type: "string" }, description: "slug e/ou salao_id" },
          { name: "salao_id", in: "query", schema: { type: "integer" }, example: 107521 },
          { name: "numero", in: "query", required: true, schema: { type: "integer" }, example: 6 },
          { name: "data", in: "query", schema: { type: "string" }, example: "2026-11-21", description: "aaaa-mm-dd ou dd/mm/aaaa. Padrao: hoje" },
        ],
        responses: {
          "200": {
            description: "Comanda encontrada",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean", example: true },
                    slug: { type: "string" },
                    salao_id: { type: "integer", nullable: true },
                    comanda: {
                      type: "object",
                      properties: {
                        origem: { type: "string", enum: ["abertas", "finalizadas"] },
                        numero: { type: "integer", example: 6 },
                        data: { type: "string", example: "21/11/2026" },
                        cliente: { type: "string", example: "88888808 - Ludmila (Gerente Beyond)" },
                        caixa: { type: "string", nullable: true },
                        aberta_em: { type: "string", example: "21/11/2026 12:02" },
                        valor: { type: "number", example: 959 },
                        resumo_pagamento: {
                          type: "object",
                          properties: {
                            caixa: { type: "string", nullable: true },
                            saldo_cliente: { type: "number", nullable: true },
                            total: { type: "number", nullable: true },
                            a_cobrar: { type: "number", nullable: true },
                            troco: { type: "number", nullable: true },
                          },
                        },
                      },
                    },
                    itens: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          tipo: { type: "string", nullable: true, example: "salao_servicos" },
                          item: { type: "string", example: "Manicure" },
                          profissional: { type: "string", nullable: true, example: "Leticia" },
                          comissao_pct: { type: "number", nullable: true, example: 55 },
                          quantidade: { type: "number", example: 1 },
                          valor_unitario: { type: "number", example: 60 },
                          desconto_pct: { type: "number", example: 0 },
                          total: { type: "number", example: 60 },
                        },
                      },
                    },
                    pagamentos: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          forma: { type: "string", example: "Cortesia" },
                          informacao: { type: "string", nullable: true },
                          parcelas: { type: "integer", nullable: true, example: 1 },
                          data_cobranca: { type: "string", nullable: true },
                          valor: { type: "number", example: 110 },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          "400": { description: "Parametros invalidos", content: { "application/json": { schema: errorSchema({ error: "invalid_params", message: "Parametros invalidos" }) } } },
          "401": { description: "`not_logged_in` ou `session_expired`", content: { "application/json": { schema: errorSchema({ error: "not_logged_in", message: "Faca login em POST /auth/login primeiro." }) } } },
          "404": { description: "`comanda_not_found` (nem abertas nem finalizadas) ou `salao_not_found`", content: { "application/json": { schema: errorSchema({ error: "comanda_not_found", message: "Comanda Nº0099 de 21/11/2026 nao encontrada" }) } } },
          "409": { description: "Sessao ocupada", content: { "application/json": { schema: errorSchema({ error: "session_busy", message: "Operacao em andamento" }) } } },
          "502": { description: "Falha ao executar a operacao", content: { "application/json": { schema: errorSchema({ error: "service_error", message: "Falha ao consultar a comanda" }) } } },
        },
      },
      post: {
        tags: ["Comandas"],
        summary: "Abrir comanda",
        description:
          "Usa a sessao ja logada do cliente (faca `POST /auth/login` antes). **Grava uma comanda real.** " +
          "Informe `cpf`, `phone`, `codigo` ou `email` do cliente (se vierem varios, vale a ordem codigo, cpf, phone, email). " +
          "Se `numero` nao for enviado, usa o maior numero de comanda existente + 1.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  slug: { type: "string", example: "les-sens-experience-byd", description: "slug e/ou salao_id" },
                  salao_id: { type: "integer", example: 107521 },
                  numero: { type: "string", example: "8", description: "Opcional (digitos)" },
                  data: { type: "string", example: "2026-11-21", description: "aaaa-mm-dd ou dd/mm/aaaa. Padrao: hoje" },
                  codigo: { type: "string", example: "88888947" },
                  cpf: { type: "string", example: "123.456.789-09" },
                  phone: { type: "string", example: "(11) 91234-5678" },
                  email: { type: "string", example: "cliente@email.com" },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Comanda aberta",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean", example: true },
                    slug: { type: "string" },
                    salao_id: { type: "integer", nullable: true },
                    comanda: {
                      type: "object",
                      properties: {
                        numero: { type: "string", example: "8" },
                        data: { type: "string", example: "21/11/2026" },
                        cliente: { type: "string", example: "Murilo" },
                        busca: {
                          type: "object",
                          properties: { campo: { type: "string", example: "codigo" }, valor: { type: "string" } },
                        },
                        id_externo: { type: "string", nullable: true },
                      },
                    },
                  },
                },
              },
            },
          },
          "400": { description: "Parametros invalidos", content: { "application/json": { schema: errorSchema({ error: "invalid_params", message: "informe codigo, cpf, phone ou email do cliente" }) } } },
          "401": { description: "Sem sessao (`not_logged_in`) ou sessao expirada (`session_expired`)", content: { "application/json": { schema: errorSchema({ error: "not_logged_in", message: "Faca login em POST /auth/login primeiro." }) } } },
          "403": { description: "Cliente inativo", content: { "application/json": { schema: errorSchema({ error: "customer_inactive", message: "Cliente inativo" }) } } },
          "404": { description: "Cliente da comanda (`cliente_nao_encontrado`) ou salao nao encontrado", content: { "application/json": { schema: errorSchema({ error: "client_not_found", message: "Nenhum cliente encontrado" }) } } },
          "409": { description: "Sessao ocupada (`session_busy`) ou cliente ja tem comanda em aberto (`already_open`)", content: { "application/json": { schema: errorSchema({ error: "session_busy", message: "Operacao em andamento" }) } } },
          "422": { description: "Recusada (ex.: numero ja usado, data invalida)", content: { "application/json": { schema: errorSchema({ error: "rejected", message: "motivo da recusa" }) } } },
          "502": { description: "Falha ao executar a operacao", content: { "application/json": { schema: errorSchema({ error: "service_error", message: "Falha ao abrir a comanda" }) } } },
          "504": { description: "Tempo esgotado", content: { "application/json": { schema: errorSchema({ error: "timeout", message: "Tempo esgotado" }) } } },
        },
      },
    },
    "/relatorios/{codigo}": {
      get: {
        tags: ["Relatorios"],
        summary: "Consultar um relatorio",
        description:
          "Usa a sessao ja logada do cliente e devolve todas as linhas do relatorio (sem paginacao). " +
          "Todo query param que nao seja `slug`/`salao_id` e tratado como filtro do relatorio " +
          "(ex.: o relatorio 0123 tem `inicio` e `fim`); um filtro que o relatorio nao tem devolve 400 com `filtros_disponiveis`. " +
          "Datas aceitam `aaaa-mm-dd` ou `dd/mm/aaaa`. Valores vem formatados (ex.: `1.800,00`). " +
          "A consulta e lenta (30-60s). Somente leitura.",
        parameters: [
          { name: "codigo", in: "path", required: true, schema: { type: "string" }, example: "0123" },
          { name: "slug", in: "query", schema: { type: "string" }, description: "slug e/ou salao_id" },
          { name: "salao_id", in: "query", schema: { type: "integer" }, example: 107521 },
          { name: "inicio", in: "query", schema: { type: "string" }, example: "2026-11-01", description: "Filtro do relatorio 0123 (Data Inicio)" },
          { name: "fim", in: "query", schema: { type: "string" }, example: "2026-11-21", description: "Filtro do relatorio 0123 (Data Fim)" },
        ],
        responses: {
          "200": {
            description: "Linhas do relatorio",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean", example: true },
                    slug: { type: "string" },
                    salao_id: { type: "integer", nullable: true },
                    codigo: { type: "string", example: "0123" },
                    titulo: { type: "string", nullable: true, example: "0123 - Profissionais e todas as comissoes por periodo" },
                    filtros: { type: "object", additionalProperties: { type: "string" }, example: { inicio: "01/11/2026", fim: "21/11/2026" } },
                    totais: { type: "object", additionalProperties: { type: "string" }, example: { "Total Faturado": "20.746,00" } },
                    colunas: { type: "array", items: { type: "string" } },
                    total: { type: "integer", example: 22 },
                    linhas: {
                      type: "array",
                      items: { type: "object", additionalProperties: { type: "string", nullable: true } },
                      example: [{ Profissional: "Aline Patricia", Cargo: "Podologista", Faturado: "1.800,00" }],
                    },
                  },
                },
              },
            },
          },
          "400": { description: "`invalid_params`, `invalid_filter` (com `filtros_disponiveis`) ou `invalid_value`", content: { "application/json": { schema: errorSchema({ error: "invalid_filter", message: "O relatorio 0123 nao tem o filtro \"foo\"" }) } } },
          "401": { description: "`not_logged_in` ou `session_expired`", content: { "application/json": { schema: errorSchema({ error: "not_logged_in", message: "Faca login em POST /auth/login primeiro." }) } } },
          "404": { description: "`relatorio_not_found` ou `salao_not_found`", content: { "application/json": { schema: errorSchema({ error: "relatorio_not_found", message: "Relatorio 9999 nao encontrado" }) } } },
          "409": { description: "Sessao ocupada", content: { "application/json": { schema: errorSchema({ error: "session_busy", message: "Operacao em andamento" }) } } },
          "422": { description: "Relatorio sem linhas para ler (ex.: relatorio em formato de painel)", content: { "application/json": { schema: errorSchema({ error: "relatorio_unsupported", message: "Relatorio em formato de painel" }) } } },
          "502": { description: "Falha ao executar a operacao", content: { "application/json": { schema: errorSchema({ error: "service_error", message: "Falha ao consultar o relatorio" }) } } },
          "504": { description: "Tempo esgotado", content: { "application/json": { schema: errorSchema({ error: "timeout", message: "Tempo esgotado na busca do relatorio" }) } } },
        },
      },
    },
    "/auth/login": {
      post: {
        tags: ["Auth"],
        summary: "Login",
        description:
          "Abre a sessao do cliente. Se ja houver uma sessao ativa para o `slug` e o usuario " +
          "continuar logado, ela e reaproveitada (`reused: true`). Clientes desativados nao " +
          "conseguem novos logins (403).",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["email", "password"],
                description: "Informe `slug`, `salao_id` ou ambos.",
                properties: {
                  email: { type: "string", format: "email", example: "gestor@salao.com" },
                  password: { type: "string", format: "password", example: "minha-senha" },
                  slug: {
                    type: "string",
                    description:
                      "Slug do estabelecimento. Obrigatorio no primeiro acesso de um cliente novo.",
                    example: "les-sens-experience-byd",
                  },
                  salao_id: {
                    type: "integer",
                    description:
                      "Id do salao. Se vier sem `slug`, o slug e buscado pelo cadastro. Aceita numero ou string numerica.",
                    example: 107521,
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Login realizado (ou sessao reaproveitada)",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["success", "slug", "sessionId", "reused"],
                  properties: {
                    success: { type: "boolean", example: true },
                    slug: { type: "string", example: "les-sens-experience-byd" },
                    salao_id: { type: "integer", nullable: true, example: 107521 },
                    nome: { type: "string", nullable: true, example: "LES SENS EXPÉRIENCE - BYD", description: "Nome do cliente" },
                    sessionId: {
                      type: "string",
                      description: "Id da sessao",
                      example: "9f2c1a7b3d4e5f60",
                    },
                    reused: {
                      type: "boolean",
                      description: "true quando continuou uma sessao ja aberta",
                      example: false,
                    },
                  },
                },
              },
            },
          },
          "400": {
            description:
              "Parametros invalidos (`invalid_params`) ou slug e salao_id que nao pertencem ao mesmo cliente (`slug_salao_mismatch`)",
            content: {
              "application/json": {
                schema: errorSchema({
                  error: "invalid_params",
                  message: "email, password e (slug ou salao_id) sao obrigatorios",
                }),
              },
            },
          },
          "401": {
            description: "E-mail ou senha incorretos",
            content: {
              "application/json": {
                schema: errorSchema({
                  error: "invalid_credentials",
                  message: "E-mail ou senha incorretos.",
                }),
              },
            },
          },
          "403": {
            description: "Cliente desativado",
            content: {
              "application/json": {
                schema: errorSchema({
                  error: "customer_inactive",
                  message: 'O cliente "exemplo" esta desativado',
                }),
              },
            },
          },
          "404": {
            description: "salao_id informado sem slug e sem cadastro",
            content: {
              "application/json": {
                schema: errorSchema({
                  error: "salao_not_found",
                  message: "Nenhum cliente com salao_id 424242.",
                }),
              },
            },
          },
          "409": {
            description: "Ja existe uma operacao em andamento para o slug",
            content: {
              "application/json": {
                schema: errorSchema({
                  error: "session_busy",
                  message: 'Ja existe uma operacao em andamento para o slug "exemplo"',
                }),
              },
            },
          },
          "502": {
            description:
              "Servico temporariamente indisponivel",
            content: {
              "application/json": {
                schema: errorSchema({
                  error: "service_unavailable",
                  message: "Servico temporariamente indisponivel",
                }),
              },
            },
          },
        },
      },
    },
  },
} as const;
