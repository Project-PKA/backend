# AGENTS.md

Contexto para pessoas e agentes de IA que trabalham neste repositório. Leia
inteiro antes de mexer em qualquer coisa.

> **Leia antes, no `shared`:** [`OWNER.md`](https://github.com/Project-PKA/shared/blob/main/OWNER.md)
> é o canal com o dono: decisões e ações que ele ainda precisa tomar. Se um item de lá
> bloqueia a sua tarefa, pare e avise; não escolha por ele. O que depender do dono se escreve lá.

## 1. Visão geral

**pokemonAuction** (nome provisório) é um SaaS B2B multi-tenant para lojistas
de Trading Card Games (Pokémon, entre outros) fazerem leilões de cartas em
grupos de WhatsApp. Este repositório é a **API** (Node.js + TypeScript +
Fastify + PostgreSQL com Drizzle): login, lojas e equipe, estoque, clientes,
leilões, acertos, dashboards, e o **dono único do schema do banco**.

O que **não** está aqui:

- A conversa com o WhatsApp (neonize em Python, sessões por QR Code, leitura de lances,
  abertura e fechamento no horário): é o `Project-PKA/whatsapp_microservice`.
  Ele usa este mesmo banco, com role própria.
- A interface web: `Project-PKA/frontend_web` (ainda não iniciada).
- Pagamento, frete e envio: fora do sistema (ADR 0002; frete e envio saíram na migration 0022, a pedido do dono). A plataforma **não vende nem
  garante pagamento ou entrega** (ADR 0013): nenhuma tela, e-mail ou
  mensagem pode usar linguagem de garantia ("anti-calote", "compra segura").

**docs/shared do projeto:** `Project-PKA/shared`. Antes de decisão de
arquitetura ou de contrato de API, leia o `ARCHITECTURE.md`, as ADRs
(`docs/adr/`) e o `GLOSSARY.md` de lá, de preferência clonado ao lado deste
repositório (`../shared`). Se não estiver clonado, peça para clonar. O
contrato publicado lá é **gerado daqui** (`make openapi`): não o edite no
shared. Use os termos do `GLOSSARY.md` ao nomear campos e endpoints.

**Escopo de produto:** `shared/docs/produto.md` (papéis, regras e mapa de
telas). O acesso é **somente por convite**, existe uma área `/admin` para o
administrador da plataforma, e há **páginas públicas** por link (vitrine,
acerto do cliente, acompanhamento do consignador). O que falta e em que
ordem está em [`docs/roadmap.md`](docs/roadmap.md).

**Estado atual:** Etapas 1, 2a, 2b, 2c, 3, 4 (sem a exclusão LGPD), 5 (sem o bot), 6, 7 e 8 (sem a cobrança) prontas: scaffold, schema com seed, RLS e papéis
de banco, login por código, sessão com refresh rotacionado, convites, middleware
de loja e RBAC, criar e editar loja, equipe, convites por rota, log de atividades
e limites de HTTP (rotas `/v1/auth`, `/v1/me`, `/v1/stores`, `/v1/store`, `/v1/team*`,
`/v1/activity-log`, `/v1/catalog*`, `/v1/cards*`, `/v1/auctions*`, `/v1/customers*`, `/v1/settlements*`, `/v1/public-links*`, `/v1/dashboard/home`, `/v1/finance/*` e `/v1/public/*` sem login e `/v1/admin/*` só do administrador).
Faltam a cobrança e o bot. E-mail sai por SMTP (nodemailer; Mailpit no compose) e as fotos das cartas ficam em disco (`src/storage`, `STORAGE_DIR`). O que vem a seguir está nas issues
da próxima sprint (milestones). A VPS
ainda não existe, então não há deploy.

## 2. Comandos

Todos passam pelo contrato do `Makefile`; os comandos reais ficam em
`project.mk`.

| Comando | O que faz | Observação |
| --- | --- | --- |
| `make setup` | `npm ci` e ativa os hooks | Primeira coisa após o clone |
| `docker compose up -d db` | Sobe o Postgres local | Porta 5432 |
| `make migrate` | Aplica as migrations pendentes | `npm run db:rollback` reverte a última |
| `make seed` | Recria os dados de desenvolvimento | **Apaga o banco.** Recusa `APP_ENV` fora de `local`/`dev`/`test` |
| `npm run db:provision-dev` | Cria o papel `app_api` (sem `BYPASSRLS`) para o `make run` | Só dev; roda uma vez depois do `make migrate` |
| `npm run error-codes:generate` | Regrava `docs/api/error-codes.json` (todos os `code` de erro) | Um teste confere que está em dia |
| `npm run maintenance:purge` | Apaga agora o que venceu (sessões, OTP, falhas por IP, links e convites antigos) | O job diário às 04:30 exige `REDIS_URL` |
| `npm run catalog:sync` | Sincroniza o catálogo do TCGdex agora | Carga inicial; o job das 03:00 exige `REDIS_URL` |
| `npm run db:create-admin -- <email> [nome]` | Cria ou promove o administrador da plataforma | Único caminho para isso; usa `MIGRATION_DATABASE_URL` |
| `make migration NAME=cria-x` | Cria `migrations/000N_cria-x/{up,down}.sql` | Atualize `src/db/schema.ts` e o seed no mesmo PR |
| `make run` | API em modo watch | Porta 8080 |
| `make build` | Compila para `dist/` | |
| `make lint` | ESLint (inclui `sonarjs`) | `make lint-fix` corrige |
| `make format` | Prettier | `make format-check` só verifica |
| `make typecheck` | `tsc --noEmit` | |
| `make test` | Vitest (unitário + integração) | **Exige Docker** (Testcontainers) |
| `make test-coverage` | Com cobertura, piso 70% | Grava `coverage/lcov.info` |
| `make openapi` | Gera `docs/api/openapi.yaml` do código | Commite o resultado |
| `make validate` | Formato + lint + tipos + testes | **Rode antes de abrir PR** |
| `make doctor` | O que está configurado e o que falta | |

**Windows:** `make` não vem instalado. Use WSL, ou
`winget install ezwinports.make`. Sem `make`, os alvos equivalem a
`npm run <script>` e `npx` (ver `project.mk`).

## 3. Convenções

**Stack e versões** (`STACK.md`): Node 22 (`.tool-versions`), TypeScript 6
(o `typescript-eslint` ainda não aceita o 7), Fastify 5, Drizzle ORM, Vitest.

**Código**

- ESM puro (`"type": "module"`). Imports relativos terminam em `.js`, mesmo
  em arquivo `.ts`.
- `strict` e `noUncheckedIndexedAccess` ligados. Sem `any`, sem `@ts-ignore`.
- Nomes: `camelCase` no TypeScript, `snake_case` no banco, `UPPER_SNAKE` nos
  enums. Mensagens ao usuário e comentários em português; identificadores em
  inglês, exceto termos de domínio do `GLOSSARY.md`.
- Função com complexidade cognitiva acima de 15 reprova no lint: quebre.

**API**

- Rotas de negócio sob `/v1`. `GET /health`, `/ready` e `/metrics` ficam fora
  da versão e sem autenticação.
- Erros sempre em RFC 9457 (`application/problem+json`) via
  `src/http/problem.ts`, com `code` para o erro de negócio. Nunca devolva
  mensagem interna nem stack em erro 5xx.
- Todo corpo e parâmetro tem **schema** na rota (ele valida a entrada e
  gera o OpenAPI). Campo extra é descartado.
- Listas paginadas por cursor (`cursor`, `limit`, resposta com `next_cursor`).
- **Isolamento por loja:** toda rota autenticada de negócio exige
  `x-store-id`, o middleware valida a participação em `store_members`, e
  **toda query filtra por `store_id`**. A única tabela global é
  `tcgdex_catalog`. Além do filtro, vale o **RLS do Postgres** (ADR 0011, a
  partir da Etapa 2): query de negócio roda em transação com
  `app.store_id` definido, e o filtro no código não é dispensado por isso.

**Áreas da API:** `/v1/auth`, `/v1/me`, rotas da loja (com `x-store-id`),
`/v1/admin` (só administrador da plataforma) e `/v1/public` (sem login, por
token). O administrador **não** lê nem altera dados internos das lojas, e
isso vale no banco (RLS), não só na rota. Rota pública nunca consulta tabela
direto: usa função `SECURITY DEFINER` auditada (ADR 0014).

**Área `/v1/admin/*`:** só `requirePlatformAdmin`. Lê e altera contas, lojas e convites; **nunca** estoque, clientes, leilões, lances nem acertos (o RLS barra, com teste). O administrador não grava no log da loja: ações da plataforma vão para `admin_activity_log` (e, quando afetam uma loja, também para o log dela, com o contexto da loja definido).

**Rotas públicas (`/v1/public/*`):** nunca consultam tabela. Rodam com `SET LOCAL ROLE public_runtime`
(sem privilégio em nenhuma tabela) e chamam só as funções `public_*` (`SECURITY DEFINER`, `search_path`
fixo, migration 0015). O token vai no **corpo** (nunca na URL), em hash no banco; qualquer falha de link
responde `404 PUBLIC_LINK_NOT_FOUND` idêntico. Função pública nova passa pela aprovação da seção 6.

**Autenticação e acesso a dados**

- Rota autenticada usa `preValidation: [hooks.authenticate]` e, se for de uma
  loja, `hooks.requireStore` (depois `requirePermission(...)` ou `requireOwner`).
  É `preValidation` de propósito: 401 e 403 vêm antes de erro de validação.
- **Todo acesso a tabela de loja passa por `withContext(db, { storeId, userId }, fn)`**
  (`src/db/context.ts`). Fora dele o RLS devolve zero linhas. Nunca use
  `db` direto em `customers`, `cards_inventory`, `auctions`, `bids`,
  `settlements`, `settlement_items`, `stores` ou `store_members`.
- Acesso é só por convite: pedir OTP para e-mail sem conta ativa responde
  igual e não envia nada. Não crie rota que cadastre usuário aberto.
- Resposta de erro de autenticação é genérica e idêntica (nada de "e-mail não
  existe"). Segredo e token só em hash no banco.

- **Log de atividades:** ação sensível de loja chama `recordActivity(tx, ...)` **dentro
  da transação da própria ação** (`src/audit/activity.ts`). Só ids e valores técnicos em
  `details`: nunca e-mail, telefone ou CPF. A tabela é imutável (sem `UPDATE`/`DELETE`).
- **Listas** paginam por cursor com `src/http/pagination.ts` (`pageQuerySchema`, `toPage`).

**Banco** (`docs/database.md`)

- Migration SQL à mão, numerada, com `up.sql` **e** `down.sql` testados.
  Migration aplicada nunca é editada (o runner confere o checksum).
- IDs `uuid`; dinheiro `numeric(12,2)` (chega como `string`, nunca `number`);
  datas `timestamptz`.
- `short_code` da carta é guardado **sem o `#`**.
- Regra que o Drizzle não expressa (CHECK, índice parcial, FK circular) mora
  só no SQL. `test/schema.integration.test.ts` falha se `schema.ts` e o banco
  divergirem.

**Ambiente:** variável nova entra em três lugares: `.env.example`,
`src/config/env.ts` (falha no boot se faltar) e nos Secrets/Variables do
GitHub Environment (nomes em `docs/secrets.md`). `DATABASE_URL` é o papel da API
(sujeito ao RLS); `MIGRATION_DATABASE_URL` é o dono do schema (migrations, seed,
`db:create-admin`) e **nunca** vai para a API em execução.

**Segurança** (`SECURITY.md` tem a lista completa): nunca registre em log
telefone, e-mail, CPF, token ou mensagem de lance; segredo nunca em código,
issue, PR ou chat.

## 4. Regras de commit e PR

**Branches:** `feature/`, `fix/`, `hotfix/`, `release/`, `chore/`, `docs/`,
`refactor/` ou `test/` + slug em minúsculas. Por exemplo,
`feature/cadastro-de-cartas`.

**Commits:** [Conventional Commits](https://www.conventionalcommits.org),
`tipo(escopo): descrição no imperativo`.

```
feat(estoque): adiciona cadastro de carta com busca no catálogo
fix(lances): rejeita lance abaixo do incremento mínimo
feat(api)!: remove o campo legado de resposta
```

Tipos: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`,
`ci`, `chore`, `revert`. As regras vivem em `scripts/conventions.sh` (hooks
locais), cópia das regras centrais de `IgorOCosta/workflows` usadas pelo CI.

**Issues e sprints:** o trabalho vem de issues organizadas em milestones
("Sprint NN - ..."); veja [`shared/docs/processo.md`](https://github.com/Project-PKA/shared/blob/main/docs/processo.md). Antes de
começar, leia a issue (critérios de aceite e segurança); ao terminar, comente o
que foi feito e feche pela mensagem do PR (`Closes #N`). Issue com
`decisao-pendente` ou `bloqueada` não se implementa: pergunte ou registre a
decisão primeiro.

**Pull requests**

- O título também segue Conventional Commits, porque vira a mensagem do
  squash merge e alimenta o CHANGELOG e a versão (release-please).
- Preencha o template inteiro, inclusive o checklist OWASP quando tocar
  autenticação, dado pessoal ou entrada externa.
- Vincule a issue com `Closes #N`.
- PR pequeno. Refatoração ampla vai separada da mudança de comportamento.
- Merge só com `ci-success` verde e aprovação de CODEOWNER.

## 5. Checklist de conclusão de tarefa

Uma tarefa **não está pronta** enquanto todos os itens abaixo não forem
verdade. Rode os comandos; não suponha o resultado.

- [ ] `make validate` passa
- [ ] Teste novo cobrindo o comportamento adicionado ou o bug corrigido
- [ ] Schema mudou: migration com `up` **e** `down`, `src/db/schema.ts` e seed atualizados;
      tabela nova: `GRANT` ao `app_runtime` e, se for de loja, RLS com `FORCE`
- [ ] Rota nova: schema de entrada e saída, `store_id` filtrado, autorização
      checada no servidor e teste de acesso cruzado entre lojas
- [ ] Contrato mudou: `make openapi` rodado e o arquivo commitado
- [ ] Erro novo com `code` novo: `npm run error-codes:generate` rodado e `docs/api/error-codes.json` commitado (o frontend traduz pelo `code`; um teste falha se o arquivo ficar desatualizado)
- [ ] Variável de ambiente nova nos três lugares da seção 3
- [ ] Nenhum log com dado pessoal, teste `only`/`skip` ou segredo no código
- [ ] `npm audit` sem vulnerabilidade nova
- [ ] Documentação atualizada quando o comportamento ou a arquitetura mudou
- [ ] Mensagem de commit e nome de branch nos padrões da seção 4

Se algum item não se aplica, diga na descrição do PR por quê.

## 6. Pontos que exigem aprovação humana

Um agente **para e pergunta** antes de fazer qualquer coisa desta lista.
Propor o diff e explicar o motivo está liberado; aplicar sem confirmação, não.

- Migration destrutiva ou com dado em produção (drop, rename, backfill)
- Mudança em autenticação, autorização, sessão, criptografia ou secrets
- Mudança **incompatível** no contrato de API
- Adicionar, remover ou trocar dependência
- Mudar `project.mk` de forma que altere o que o CI executa
- Mudar `.github/workflows/**`, permissão de token ou regra de deploy
- Rodar deploy para `homolog` ou `prod`
- Afrouxar regra de qualidade (lint, cobertura, `skip`)
- `git push --force`, reescrita de histórico, `push` direto na branch padrão ou
  em branch protegida, e **merge de PR** (o `push` de branch de trabalho e o PR em
  rascunho estão autorizados desde 2026-10-17)
- Apagar teste, ou marcá-lo como `skip` para fazer o CI passar
- Rodar o seed fora de ambiente de desenvolvimento
- Qualquer coisa que envolva dado real de usuário (CPF, telefone, endereço)
- Mudar regras de convite, o papel de administrador da plataforma, a
  fronteira do administrador no RLS ou qualquer função `SECURITY DEFINER`
  usada por rota pública
- Criar ou alterar papéis de banco (`owner`, `app_runtime`, `bot`), políticas de RLS ou dar `BYPASSRLS` a qualquer papel

**Regra geral:** se o erro sai caro, sai em produção ou é difícil de
reverter, pergunte primeiro.

## 7. Armadilhas conhecidas

- **Node local antigo:** o projeto pede Node 22 (`.tool-versions`). Com Node
  20 o `npm install` falha por `engines` e o Vitest 5 não roda. Use
  `mise install` ou `asdf install`.
- **`npm ci` no Windows com npm 10.8:** pode pular o binário opcional do
  `rolldown` e o Vitest falha com "Cannot find module
  './rolldown-binding.wasi.cjs'". Use npm 10.9 ou mais novo (vem com o Node
  22 recente). No CI (Linux, Node 22) funciona; foi conferido num container.
- **`make` no Windows:** não vem instalado (seção 2).
- **Arquivos `.sql` no Windows:** nunca regrave um `.sql` com `Set-Content`
  do PowerShell 5: ele grava ANSI ou BOM e o Postgres falha com "syntax error
  at or near" um caractere invisível. Um teste confere UTF-8 sem BOM.
- **Dois papéis de banco:** o container de desenvolvimento cria `app` como
  superusuário, que **ignora o RLS**. Para a API enxergar o RLS de verdade, rode
  `npm run db:provision-dev` e use `DATABASE_URL` com `app_api`. Teste de RLS
  só vale com papel sem `BYPASSRLS`.
- **O Fastify converte tipos** nos corpos e na query (um número vira `"5"` num campo de
  texto). É o padrão do framework e os schemas já cuidam do resto; não conte com `400`
  para tipo "quase certo".
- **E-mail com espaço no começo ou no fim** é recusado pela validação (400); o
  frontend deve fazer `trim`. Maiúsculas são aceitas e normalizadas.
- **Testes de integração precisam do Docker** rodando (Testcontainers). Na
  primeira vez, baixar a imagem `postgres:17-alpine` leva alguns minutos.
- **O Drizzle não gera `down`.** Escreva e teste o `down.sql` à mão; o teste
  de reversibilidade desfaz tudo e confere que não sobrou tabela nem enum.
- **`make seed` apaga tudo** (`TRUNCATE`). Só roda em `local`/`dev`/`test`.
- **`tcgdex_catalog` não tem `store_id`**: é a exceção à regra de isolamento.
  Qualquer outra tabela nova de negócio precisa de `store_id`.
- **A FK composta `(id, store_id)`** em lances, leilões e acertos impede
  referência entre lojas no banco. Ao criar tabela nova que aponte para uma
  dessas, siga o mesmo padrão.
- **Lances:** a regra vive na função `place_bid` do Postgres (migration 0013, ADR 0016),
  que trava a linha do leilão (`FOR UPDATE`) e valida período, blacklist, incremento e
  teto. Backend e bot a chamam; **não reescreva a regra em TypeScript**. Ela devolve
  `outcome` (não lança erro de regra de negócio). A hora do lance é lida **depois** do
  lock (`clock_timestamp()`), não no início da transação.
- **Papel do bot:** `bot_runtime` (migration 0021, aprovado em D15) é NOLOGIN, sem `BYPASSRLS`, só a loja do contexto (`app.store_id`) e, por coluna, o mínimo: lê leilão, carta (sem consignador) e cliente (sem CPF, e-mail, endereço), cria visitante, chama `place_bid` e `advance_auctions`, guarda a sessão do WhatsApp e muda o estado da conexão pela função `bot_set_whatsapp_status`. Não toca em acertos, equipe, usuários nem logs. Aumentar esse acesso exige a aprovação da seção 6. Login: `DB_BOT_PASSWORD` na provisão (`provision-cli`) ou `npm run db:provision-dev` (`bot_api`).
- **Limpeza:** `purge_expired()` (migration 0019, `SECURITY DEFINER`, só `app_runtime`) apaga só o que é técnico e efêmero. **Não** apague dado pessoal por aqui (pedidos de acesso, avisos, clientes): o prazo é a decisão de LGPD (D2). O log de atividades é imutável.
- **Fotos e arquivos:** o corpo do `PUT` é a imagem crua (sem multipart); o tipo vem dos primeiros bytes (`sniffImage`), nunca do `Content-Type`, e o nome do arquivo é gerado (`<loja>/<carta>/<uuid>.<ext>`). Nada vindo do cliente vira caminho. A carta guarda só o id em `custom_photos`. O `DiskStorage` implementa `FileStorage`; os testes usam `MemoryStorage`.
- **Comprovante do "já paguei":** `PUT /v1/public/settlement/receipt` (imagem crua, token no header `x-public-token`) chama `public_settlement_receipt_attach` (migration 0020, aprovada em shared#25). O arquivo é gravado antes e apagado se o banco não responder `OK`; fica em `receipts/<uuid>.<ext>`. A loja baixa por `GET /v1/settlements/:id/receipt`.
- **E-mail:** `EMAIL_PROVIDER=smtp` usa nodemailer (`src/auth/smtp.ts`). Falha de envio vai ao log sem destinatário nem conteúdo. Gmail exige senha de app e limita ~500 envios por dia.
- **Deploy:** `scripts/deploy.sh` + `deploy/` (compose de produção, Caddy, backup e restauração). A API no compose recebe só as variáveis listadas em `environment`, nunca a senha do dono do schema.
- **Abrir e encerrar leilões:** `advance_auctions(loja)` vira o estado conforme o relógio
  do banco (abre, encerra, define vencedor, devolve a carta). A API a chama ao listar,
  detalhar e agir, e um job do BullMQ (`src/jobs/auctions.ts`, a cada minuto) a chama para
  todas as lojas. O job só existe com `REDIS_URL`; sem ele, os leilões só viram quando
  alguém abre a loja.
- **`prom-client` está deprecado no npm** e o ESLint 9 saiu de suporte:
  revisar antes de produção (`STACK.md`, seção 8).
- **`BOOTSTRAP.md` e `SETUP-GITHUB.md` ainda existem** de propósito: o
  bootstrap só termina com Dockerfile, CI verde, SonarCloud e Environments
  configurados. Apague-os em commit próprio nesse momento.
