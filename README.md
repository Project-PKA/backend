# pokemonAuction · Backend

> Nome provisório. API do SaaS que permite a lojistas de Trading Card Games
> (Pokémon e outros) fazerem leilões de cartas em grupos de WhatsApp.

Plataforma web multi-tenant (várias lojas, dados 100% isolados) integrada a um
bot de WhatsApp. O lojista cadastra a carta física no estoque (própria ou
consignada), agenda o leilão, acompanha os lances que chegam no grupo e fecha
o acerto com o comprador. O acesso é **somente por convite**. O escopo de produto
(`docs/produto.md`), o contexto de negócio e as decisões estão no
repositório [`Project-PKA/shared`](https://github.com/Project-PKA/shared).

## Repositórios do projeto

| Repositório | Papel |
| --- | --- |
| **Backend** (este) | API, autenticação, regras de negócio e **dono do schema** |
| [`whatsapp_microservice`](https://github.com/Project-PKA/whatsapp_microservice) | Sessões de WhatsApp, leitura de lances, disparos e moderação do grupo |
| [`frontend_web`](https://github.com/Project-PKA/frontend_web) | Painel do lojista e landing page |
| [`shared`](https://github.com/Project-PKA/shared) | Contrato de API, ADRs e glossário |

## Stack

Node.js 22 · TypeScript 6 · Fastify 5 · PostgreSQL 17 (`pg_trgm`, JSONB) ·
Drizzle ORM · BullMQ + Redis (jobs, ainda não ligado) · Vitest + Testcontainers ·
ESLint (`sonarjs`) + Prettier. O porquê de cada escolha está em
[`STACK.md`](STACK.md).

## Rodando localmente

Requisitos: Node 22 (`mise install` lê o `.tool-versions`), Docker e `make`
(no Windows: `winget install ezwinports.make` ou WSL).

```bash
cp .env.example .env
make setup                   # instala dependências e ativa os hooks de git
docker compose up -d db      # Postgres local
make migrate                 # cria o schema (usa MIGRATION_DATABASE_URL)
npm run db:provision-dev     # cria o papel app_api, que sofre o RLS
make seed                    # dados de desenvolvimento (apaga o banco!)
make run                     # API em http://localhost:8080 (usa DATABASE_URL)
```

O provedor de e-mail local imprime o código de login no log da API (só em
desenvolvimento). Contas do seed: `dono@example.com` (proprietário de duas
lojas), `funcionario@example.com` e `admin@example.com`.

Conferindo:

```bash
curl localhost:8080/health   # {"status":"ok"}
curl localhost:8080/ready    # {"status":"ready"}  (503 se o banco cair)
```

Antes de abrir PR: `make validate` (formato, lint, tipos e testes; os testes
de integração sobem um Postgres em container, então o Docker precisa estar
rodando).

## Estado do projeto

| Pronto | Falta (ver [`docs/roadmap.md`](docs/roadmap.md)) |
| --- | --- |
| Health, ready, metrics, erros `problem+json`, limites de corpo e timeouts | API `/v1/admin` e solicitações de acesso (Etapa 2c) |
| Schema (15 tabelas) com migrations `up`/`down`, RLS e seed | Estoque e catálogo (Etapa 3), clientes (4) |
| Login por código, sessão com refresh rotacionado, convites, tenant e RBAC | Leilões e bot (5), acertos e páginas públicas (6) |
| Criar e editar loja, equipe, convites, log de atividades | Painéis (7), vitrine, planos e perfil (8) |
| Contrato OpenAPI gerado do código (23 operações) | |
| Testes com Postgres real, 70% de cobertura mínima | Leilões, bot, acertos, envios e páginas públicas |
| | Painéis (Home ao vivo e Financeiro), vitrine, planos, perfil |
| | Dockerfile e deploy (a VPS ainda não existe) |

## Documentação

| Arquivo | Para que serve |
| --- | --- |
| [`AGENTS.md`](AGENTS.md) | Contexto para pessoas e agentes de IA. **Comece por aqui.** |
| [`docs/roadmap.md`](docs/roadmap.md) | Roteiro de entrega revisado, mudanças de schema previstas e decisões em aberto |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Camadas, diagramas, banco, autenticação, secrets, observabilidade |
| [`STACK.md`](STACK.md) | Por que cada ferramenta foi escolhida |
| [`SECURITY.md`](SECURITY.md) | Reporte de vulnerabilidade e requisitos de segurança do projeto |
| [`TESTING.md`](TESTING.md) | Estratégia de testes |
| [`DEPLOY.md`](DEPLOY.md) | Ambientes e fluxo de deploy na VPS |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Branches, commits, PR e release |
| [`docs/database.md`](docs/database.md) | Regras de ORM, migrations e seeds |
| [`docs/secrets.md`](docs/secrets.md) | Nomes dos secrets e como obter cada um |
| [`migrations/README.md`](migrations/README.md) | Como criar e reverter migrations |

`BOOTSTRAP.md` e `SETUP-GITHUB.md` são roteiros temporários do setup inicial
e serão apagados quando ele terminar.
