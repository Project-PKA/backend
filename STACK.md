# Stack

> **Esqueleto do template.** Este repositório não escolhe stack: ele fornece
> o **formato** para registrar as escolhas do projeto e o critério para
> fazê-las. As perguntas de cada seção são conduzidas pelo
> [`BOOTSTRAP.md`](BOOTSTRAP.md).
>
> O valor deste arquivo não está na lista de ferramentas, mas em registrar
> o **critério** e a **alternativa descartada**. Daqui a um ano, quando
> alguém perguntar "por que não usamos X?", a resposta precisa estar escrita.

---

## O formato

Para cada escolha relevante, registre cinco coisas:

1. **Escolha:** o que foi adotado, com versão.
2. **Critério:** o que importava na hora de decidir.
3. **Por quê:** como a escolha atende o critério.
4. **Descartado:** o que mais foi considerado e por que não.
5. **Quando reabrir:** que fato tornaria essa decisão errada.

---

## Resumo

<!-- Preencha durante o bootstrap. Versões exatas do runtime ficam em
     .tool-versions; os comandos, em project.mk. -->

| Camada | Escolha | Versão | Seção |
| --- | --- | --- | --- |
| Linguagem e runtime | <!-- --> | <!-- --> | 1 |
| Framework HTTP | <!-- --> | <!-- --> | 2 |
| Banco e ORM/migrations | <!-- --> | <!-- --> | 3 |
| Lint, formatação, tipos | <!-- --> | <!-- --> | 4 |
| Testes | <!-- --> | <!-- --> | 5 |
| Observabilidade | <!-- --> | <!-- --> | 6 |
| Plataforma de deploy | <!-- --> | — | 7 |

---

## 1. Linguagem e runtime

**Critérios que costumam importar:** o que o time domina, o que a
organização já opera, o ecossistema para os requisitos da etapa 2 (filas,
tempo real, integrações) e o custo de contratação.

**Escolha:** Node.js + TypeScript (versão exata a fixar em `.tool-versions`).
**Critério:** mesma linguagem do `whatsapp_microservice` (Baileys é Node) e do
frontend provável; ecossistema para filas, tempo real e OpenAPI.
**Por quê:** um único idioma nos três repositórios reduz custo de manutenção
para quem mantém sozinho.
**Descartado:** Python e Go. Nenhum tem a biblioteca de WhatsApp Web que o
projeto usa, e o bot precisaria de outra linguagem.
**Quando reabrir:** se o bot deixar de usar Baileys ou se um gargalo de CPU
medido não couber em Node.

## 2. Framework HTTP

**Requisito da fundação:** gerar OpenAPI **a partir do código**
(`make openapi`).

**Escolha:** Fastify · **Geração de OpenAPI:** `@fastify/swagger`
(a confirmar no scaffold).
**Critério:** OpenAPI gerado do código, validação de schema nativa, TypeScript
de primeira classe.
**Por quê:** os schemas da rota validam a entrada e alimentam o contrato ao
mesmo tempo, então código e `openapi.yaml` não divergem.
**Descartado:** Express (o doc 02 aceitava). Não gera OpenAPI nem valida
schema sozinho; exigiria bibliotecas extras para o mesmo resultado.
**Quando reabrir:** se um plugin essencial não existir para Fastify.

## 3. Banco de dados e ORM

**Requisitos da fundação** ([`docs/database.md`](docs/database.md)):
migrations numeradas e reversíveis, e tipos gerados do schema.

**Banco:** PostgreSQL com `pg_trgm` e colunas JSONB · **ORM:** Drizzle ·
**Migrations:** SQL versionado com `up` e `down` escritos e testados à mão
(o Drizzle não gera `down`).
**Compartilhado com outro serviço?** Sim: `whatsapp_microservice`, com role
própria restrita a `stores`, `customers`, `cards_inventory`, `auctions` e
`bids`. As migrations ficam só aqui
([ADR 0007](https://github.com/Project-PKA/shared/blob/main/docs/adr/0007-banco-compartilhado-e-sessao-whatsapp-por-qr-code.md)).
**Critério:** tipos gerados do schema e SQL próximo do real, porque o projeto
precisa de índice GIN `gin_trgm_ops` e extensão `pg_trgm`.
**Por quê:** o Drizzle aceita migration SQL escrita à mão, o que cobre o que
o gerador não cobre.
**Descartado:** Prisma. Não gera `down` e o índice GIN exigiria SQL manual do
mesmo jeito, então a regra do template precisaria de justificativa.
**Quando reabrir:** se escrever `down` à mão virar fonte frequente de erro.

### 3.1 Jobs assíncronos

**Escolha:** BullMQ + Redis.
**Critério:** job que não pode se perder: o sync do TCGdex (03:00) e a
limpeza de inativos precisam de retry e de reexecução se o processo cair.
**Por quê:** fila persistente com retry e agendamento repetível, e o mesmo
mecanismo serve ao microservice se ele precisar de jobs.
**Descartado:** `node-cron`. Era a opção mais leve (sem Redis), mas não
reexecuta um job perdido num restart.
**Custo aceito:** um Redis a mais na VPS (RAM disputando com as sessões de
WhatsApp), no `compose.yaml` local, no deploy e nos secrets. Precisa entrar
no `ARCHITECTURE.md` e no `DEPLOY.md`.
**Quando reabrir:** se a RAM da VPS virar o limite de lojas conectadas.

## 4. Lint, formatação e tipos

**Requisito da fundação:** o lint cobre **code smells e complexidade**, além
dos erros básicos, porque alimenta o Quality Gate do SonarCloud.

| Papel | Ferramenta | Observação |
| --- | --- | --- |
| Lint | ESLint + `typescript-eslint` + `eslint-plugin-sonarjs` | `sonarjs` cobre code smells e complexidade (requisito da fundação). Biome descartado: sem equivalente do `sonarjs`. |
| Formatação | Prettier | Separado do lint |
| Tipos | `tsc --noEmit` | |
| SonarCloud | Projeto inteiro | Duplicação, cobertura de código novo, hotspots |

## 5. Testes

**Framework:** Vitest · **Integração com banco real:** Testcontainers
(Postgres descartável; migrations aplicadas e revertidas nos testes).
**Piso de cobertura:** 70%, com `lcov.info` em `coverage/`.
**Cobertura:** grava em `coverage/` (`TEST_COVERAGE_CMD`); caminho real
em `sonar-project.properties`.
**Estratégia completa:** [`TESTING.md`](TESTING.md)

## 6. Observabilidade

| Sinal | Biblioteca |
| --- | --- |
| Logs JSON | <!-- --> |
| Métricas Prometheus | <!-- --> |
| Tracing OpenTelemetry | <!-- SDK + exporter --> |

## 7. Plataforma de deploy

**Escolha:** <!-- Kubernetes / Cloud Run / ECS / VPS / ... -->
**Critério / Por quê / Descartado / Quando reabrir:** <!-- -->
Receita e rollback em [`DEPLOY.md`](DEPLOY.md).

## 8. Dispensas conscientes

<!-- Todo `skip` em project.mk e todo "não usamos X" da fundação (ex.:
     `sonar: false`) com o motivo e quando revisitar. -->

| O que foi dispensado | Motivo | Revisitar quando |
| --- | --- | --- |
| <!-- --> | <!-- --> | <!-- --> |
