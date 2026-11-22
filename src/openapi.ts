/** Erro no padrao da API antiga: { code, message, file, line, trace }. */
const errorSchema = (code: number, message: string, extra: Record<string, unknown> = {}) => ({
  type: "object",
  required: ["code", "message"],
  properties: {
    code: { type: "integer", example: code },
    message: { type: "string", example: message },
    file: { type: "string", nullable: true, example: null },
    line: { type: "integer", nullable: true, example: null },
    trace: { type: "array", nullable: true, items: {}, example: null },
    ...extra,
  },
});

const errorResponse = (description: string, code: number, message: string, extra?: Record<string, unknown>) => ({
  description,
  content: { "application/json": { schema: errorSchema(code, message, extra) } },
});

/** Sucesso no padrao da API antiga: { code: 200, data: {...} }. */
const okResponse = (description: string, data: Record<string, unknown>, status = 200) => ({
  description,
  content: {
    "application/json": {
      schema: {
        type: "object",
        required: ["code", "data"],
        properties: {
          code: { type: "integer", example: status },
          data,
        },
      },
    },
  },
});

const salaoIdParam = {
  name: "salao_id",
  in: "path",
  required: true,
  schema: { type: "integer" },
  example: 107521,
  description: "Id do salao",
};

const sessionErrors = {
  "401": errorResponse(
    "Token ausente, invalido ou expirado; ou sessao encerrada (faca login de novo)",
    401,
    "Token invalido",
  ),
  "403": errorResponse("Token de outro salao, ou cliente desativado", 403, "Token nao pertence a este salao"),
  "404": errorResponse("Salao nao encontrado", 404, "Salao 424242 nao encontrado"),
  "409": errorResponse("Ja existe uma operacao em andamento para o salao", 409, "Ja existe uma operacao em andamento para este salao"),
  "502": errorResponse("Falha ao executar a operacao", 502, "Falha ao executar a operacao"),
};

export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "Conecta API",
    version: "0.1.0",
    description:
      "API de integracao para consulta de comandas e relatorios e abertura de comandas. " +
      "Respostas no formato `{ code, data }`; erros no formato `{ code, message, file, line, trace }`. " +
      "Faca `POST /api/auth/login` e envie o `access_token` retornado em `Authorization: Bearer <token>` nas demais rotas. " +
      "O token vale para um salao (`salao_id` do caminho precisa ser o mesmo) e para a sessao aberta no login.",
  },
  servers: [{ url: "/" }],
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
    },
  },
  tags: [
    { name: "Auth", description: "Autenticacao" },
    { name: "Clientes", description: "Clientes do salao" },
    { name: "Comandas", description: "Comandas do salao" },
    { name: "Relatorios", description: "Relatorios do salao" },
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

    "/api/auth/login": {
      post: {
        tags: ["Auth"],
        summary: "Login",
        description:
          "Abre a sessao do salao. Se ja houver uma sessao ativa e o usuario continuar logado, ela e " +
          "reaproveitada (`reused: true`). Informe `slug`, `salao_id` ou ambos (o `slug` e obrigatorio no " +
          "primeiro acesso de um salao novo). Saloes desativados nao conseguem novos logins (403).",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["email", "password"],
                properties: {
                  email: { type: "string", format: "email", example: "gestor@salao.com" },
                  password: { type: "string", format: "password", example: "minha-senha" },
                  slug: { type: "string", example: "les-sens-experience-byd" },
                  salao_id: { type: "integer", example: 107521 },
                },
              },
            },
          },
        },
        responses: {
          "200": okResponse("Login realizado (ou sessao reaproveitada)", {
            type: "object",
            properties: {
              access_token: { type: "string", example: "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9..." },
              token_type: { type: "string", example: "bearer" },
              expires_in: { type: "integer", example: 315360000, description: "Validade do token em segundos (10 anos; o token cai antes se a sessao for encerrada)" },
              user: {
                type: "object",
                properties: {
                  salao_id: { type: "integer", example: 107521 },
                  slug: { type: "string", example: "les-sens-experience-byd" },
                  nome: { type: "string", nullable: true, example: "LES SENS EXPÉRIENCE - BYD" },
                  email: { type: "string", example: "gestor@salao.com" },
                },
              },
              reused: { type: "boolean", example: false, description: "true quando continuou uma sessao ja aberta" },
            },
          }),
          "400": errorResponse("Parametros invalidos", 400, "email, password e (slug ou salao_id) sao obrigatorios", {
            errors: {
              type: "array",
              items: { type: "object", properties: { path: { type: "string" }, message: { type: "string" } } },
            },
          }),
          "401": errorResponse("E-mail ou senha incorretos", 401, "E-mail ou senha incorretos."),
          "403": errorResponse("Cliente desativado", 403, "Cliente desativado"),
          "404": errorResponse("salao_id sem cadastro e sem slug", 404, "Salao 424242 nao encontrado. Informe o slug no primeiro acesso."),
          "409": errorResponse("Ja existe uma operacao em andamento", 409, "Ja existe uma operacao em andamento para este salao"),
          "502": errorResponse("Servico temporariamente indisponivel", 502, "Servico temporariamente indisponivel"),
        },
      },
    },

    "/api/auth/user-profile": {
      get: {
        tags: ["Auth"],
        summary: "Perfil do usuario do token",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": okResponse("Usuario autenticado", {
            type: "object",
            properties: {
              user: {
                type: "object",
                properties: {
                  salao_id: { type: "integer", example: 107521 },
                  slug: { type: "string", example: "les-sens-experience-byd" },
                  nome: { type: "string", nullable: true },
                  email: { type: "string", example: "gestor@salao.com" },
                },
              },
            },
          }),
          "401": errorResponse("Token ausente, invalido ou expirado", 401, "Token invalido"),
        },
      },
    },

    "/api/mid/avec/salao/{salao_id}/cliente": {
      get: {
        security: [{ bearerAuth: [] }],
        tags: ["Clientes"],
        summary: "Buscar cliente",
        description:
          "Usa a sessao ja logada do salao. Busca por `chave` + `valor` e devolve o cadastro completo de cada " +
          "cliente encontrado (ate `limit`, padrao 10, maximo 50) em `salonClient`; `total` e a quantidade de " +
          "clientes que casam com a busca. Sem resultado devolve `salonClient: []`. `celular`, `cpf` e `codigo` " +
          "aceitam o valor com ou sem formatacao; `nome` busca por parte do nome. Somente leitura. " +
          "Pode levar alguns segundos por cliente retornado.",
        parameters: [
          salaoIdParam,
          {
            name: "chave",
            in: "query",
            required: true,
            schema: { type: "string", enum: ["celular", "telefone", "cpf", "email", "codigo", "nome"] },
            example: "celular",
          },
          { name: "valor", in: "query", required: true, schema: { type: "string" }, example: "11999999999" },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50, default: 10 } },
        ],
        responses: {
          "200": okResponse("Clientes encontrados (lista vazia se nenhum)", {
            type: "object",
            properties: {
              salonClient: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "integer", example: 127534666 },
                    salao_id: { type: "integer", example: 107521 },
                    cliente_id: { type: "integer", example: 0 },
                    codigo: { type: "integer", example: 13369 },
                    nome: { type: "string", example: "Maria Silva" },
                    email: { type: "string", nullable: true },
                    datanasc: { type: "string", nullable: true, example: "1990-06-09" },
                    telefone: { type: "string", example: "" },
                    celular: { type: "string", example: "11999999999" },
                    cpf: { type: "string", example: "" },
                    sexo: { type: "string", example: "F" },
                    endereco: { type: "string" },
                    numero: { type: "integer" },
                    bairro: { type: "string" },
                    cidade: { type: "string" },
                    estado: { type: "string" },
                    cep: { type: "string" },
                    obs: { type: "string" },
                    email_mkt: { type: "integer", example: 1 },
                    emissao_nota: { type: "boolean" },
                    agendamento_online: { type: "integer", example: 1 },
                    datacad: { type: "string", nullable: true, example: "2026-10-20 15:54:00" },
                    UA: { type: "string", nullable: true, example: "2026-10-20 15:54:00" },
                    ddi_celular: { type: "integer", example: 55 },
                    aceita_atendimento_ia: { type: "integer", example: 1 },
                    aceita_comunicacao_whatsapp: { type: "integer", example: 1 },
                  },
                  additionalProperties: true,
                },
              },
              total: { type: "integer", example: 1 },
            },
          }),
          "400": errorResponse("Parametros invalidos", 400, "Parametros invalidos"),
          ...sessionErrors,
          "404": errorResponse("Salao nao encontrado", 404, "Salao 1 nao encontrado"),
          "504": errorResponse("Tempo esgotado", 504, "A plataforma nao respondeu a busca de clientes"),
        },
      },
    },

    "/api/mid/avec/salao/{salao_id}/comandas": {
      post: {
        security: [{ bearerAuth: [] }],
        tags: ["Comandas"],
        summary: "Abrir comanda",
        description:
          "Usa a sessao ja logada do salao (faca `POST /api/auth/login` antes). **Grava uma comanda real.** " +
          "Identifique o cliente por `codigo`, `cpf`, `celular` ou `email` (se vierem varios, vale essa ordem), " +
          "ou por `chave` + `valor` (ex.: `chave: \"celular\"`). Se `numero` nao for enviado, usa o maior " +
          "numero de comanda existente + 1. `data` aceita `aaaa-mm-dd` ou `dd/mm/aaaa` (padrao: hoje).",
        parameters: [salaoIdParam],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  numero: { type: "string", example: "8", description: "Opcional (digitos)" },
                  data: { type: "string", example: "2026-11-21" },
                  codigo: { type: "string", example: "88888947" },
                  cpf: { type: "string", example: "123.456.789-09" },
                  celular: { type: "string", example: "(11) 91234-5678" },
                  email: { type: "string", example: "cliente@email.com" },
                  chave: { type: "string", enum: ["celular", "telefone", "cpf", "email", "codigo"] },
                  valor: { type: "string", description: "Valor da `chave`" },
                },
              },
            },
          },
        },
        responses: {
          "200": okResponse("Comanda aberta", {
            type: "object",
            properties: {
              comanda: {
                type: "object",
                properties: {
                  id: { type: "string", nullable: true },
                  numero: { type: "string", example: "8" },
                  data: { type: "string", example: "21/11/2026" },
                  cliente: { type: "string", example: "Murilo" },
                  busca: {
                    type: "object",
                    properties: { campo: { type: "string", example: "codigo" }, valor: { type: "string" } },
                  },
                },
              },
            },
          }),
          "400": errorResponse("Parametros invalidos", 400, "informe codigo, cpf, celular ou email do cliente (ou chave e valor)"),
          ...sessionErrors,
          "404": errorResponse("Cliente ou salao nao encontrado", 404, "Nenhum cliente encontrado por cpf \"12345678909\""),
          "409": errorResponse("Operacao em andamento ou cliente ja tem comanda em aberto", 409, "Ja existe uma operacao em andamento para este salao"),
          "422": errorResponse("Recusada (ex.: numero ja usado, data invalida)", 422, "motivo da recusa"),
          "504": errorResponse("Tempo esgotado", 504, "Tempo esgotado ao abrir a comanda"),
        },
      },
    },

    "/api/mid/avec/salao/{salao_id}/comanda/{numero}": {
      get: {
        security: [{ bearerAuth: [] }],
        tags: ["Comandas"],
        summary: "Consultar comanda (itens e pagamentos)",
        description:
          "Usa a sessao ja logada do salao. Procura a comanda pela data e numero entre as abertas e, se nao " +
          "achar, entre as finalizadas, e devolve os itens e os pagamentos. Somente leitura. " +
          "A consulta pode levar dezenas de segundos.",
        parameters: [
          salaoIdParam,
          { name: "numero", in: "path", required: true, schema: { type: "integer" }, example: 6 },
          { name: "data", in: "query", schema: { type: "string" }, example: "2026-11-21", description: "aaaa-mm-dd ou dd/mm/aaaa. Padrao: hoje" },
        ],
        responses: {
          "200": okResponse("Comanda encontrada", {
            type: "object",
            properties: {
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
          }),
          "400": errorResponse("Parametros invalidos", 400, "Parametros invalidos"),
          ...sessionErrors,
          "404": errorResponse("Comanda ou salao nao encontrado", 404, "Comanda Nº0099 de 21/11/2026 nao encontrada"),
          "504": errorResponse("Tempo esgotado", 504, "Tempo esgotado ao consultar a comanda"),
        },
      },
    },

    "/api/mid/avec/salao/{salao_id}/relatorio/{codigo}": {
      get: {
        security: [{ bearerAuth: [] }],
        tags: ["Relatorios"],
        summary: "Consultar um relatorio",
        description:
          "Usa a sessao ja logada do salao e devolve todas as linhas do relatorio (sem paginacao). " +
          "Todo query param e tratado como filtro do relatorio (ex.: o relatorio 0123 tem `inicio` e `fim`); " +
          "um filtro que o relatorio nao tem devolve 400 com `filtros_disponiveis`. " +
          "Datas aceitam `dd/mm/aaaa` ou `aaaa-mm-dd`. Valores vem formatados (ex.: `1.800,00`). " +
          "A consulta e lenta (30-60s). Somente leitura.",
        parameters: [
          salaoIdParam,
          { name: "codigo", in: "path", required: true, schema: { type: "string" }, example: "0123" },
          { name: "inicio", in: "query", schema: { type: "string" }, example: "01/11/2026", description: "Filtro do relatorio 0123 (data inicial)" },
          { name: "fim", in: "query", schema: { type: "string" }, example: "21/11/2026", description: "Filtro do relatorio 0123 (data final)" },
        ],
        responses: {
          "200": okResponse("Linhas do relatorio", {
            type: "object",
            properties: {
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
          }),
          "400": errorResponse("Filtro ou valor invalido", 400, "O relatorio 0123 nao tem o filtro \"foo\"", {
            filtros_disponiveis: { type: "array", items: { type: "string" }, example: ["inicio", "fim"] },
          }),
          ...sessionErrors,
          "404": errorResponse("Relatorio ou salao nao encontrado", 404, "Relatorio 9999 nao encontrado"),
          "422": errorResponse("Relatorio sem linhas para ler (ex.: formato de painel)", 422, "Relatorio em formato de painel"),
          "504": errorResponse("Tempo esgotado", 504, "Tempo esgotado na busca do relatorio"),
        },
      },
    },
  },
} as const;
