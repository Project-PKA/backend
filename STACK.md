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
| Logs JSON | `pino` (integrado ao Fastify), com `trace_id` |
| Métricas Prometheus | `/metrics` (lib a confirmar no scaffold, ex.: `prom-client`) |
| Tracing OpenTelemetry | SDK OpenTelemetry para Node + exporter OTLP (variáveis `OTEL_*` do `.env.example`) |

**Destino:** Prometheus e Grafana no mesmo `compose` da VPS. Custo aceito:
mais RAM, que disputa com as sessões de WhatsApp (revisitar se a RAM virar
limite). Backend e microservice seguem o mesmo padrão.

## 7. Plataforma de deploy

**Escolha:** VPS Linux ([ADR 0010](https://github.com/Project-PKA/shared/blob/main/docs/adr/0010-infraestrutura-inicial-em-vps.md)).
**Fluxo decidido:** o CI builda a imagem uma única vez e publica no GHCR; o
deploy faz SSH na VPS, roda as migrations com a mesma imagem e sobe via
`docker compose`. A mesma imagem é promovida entre `dev`, `homolog` e `prod`.
**Descartado:** build direto na VPS, porque quebra o build único e gasta
CPU e RAM da máquina.
**Status:** **a VPS ainda não foi contratada.** O fluxo está decidido, mas
nada foi implementado nem configurado. Provedor, domínio, usuário de SSH e
secrets ficam para quando o produto estiver mais avançado.
**Quando reabrir:** na contratação da VPS, ou se o número de lojas
conectadas passar do que a RAM comporta.
Receita e rollback em [`DEPLOY.md`](DEPLOY.md).

## 8. Ressalvas de versão

- **TypeScript 6.0, não 7:** o `typescript-eslint` só aceita TypeScript
  `<6.1`. Reabrir quando ele suportar o 7.
- **`prom-client` 15 está marcado como deprecado** pelo npm (substituído por
  `@prometheus-io/client`). Mantido por ora; avaliar a troca na Etapa de
  observabilidade, antes de produção.
- **Node 22.23.3** fixado em `.tool-versions`. O `package-lock.json` foi gerado
  com npm 12; confirmar que o `npm ci` do CI (Node 22) lê o lockfile.

## 9. Dispensas conscientes

<!-- Todo `skip` em project.mk e todo "não usamos X" da fundação (ex.:
     `sonar: false`) com o motivo e quando revisitar. -->

| O que foi dispensado | Motivo | Revisitar quando |
| --- | --- | --- |
| `SEED_CMD` pendente (não é `skip`) | Ainda não há tabelas; entra com o schema na Etapa 1 do backlog | Etapa 1 do backlog |
| Deploy (`scripts/deploy.sh` e passo `Publicar` do `deploy.yml` em `skip`) | A VPS ainda não existe (decisão do usuário em 2026-10-17) | A VPS for contratada |

## 10. Dependências e escolhas ainda abertas

Aprovadas na Etapa 2 (2026-10-17): `jose` (JWT), `@fastify/cookie`,
`@fastify/helmet`, `@fastify/cors` e `@fastify/rate-limit`. Hash e comparação
em tempo constante saem do `node:crypto`, sem pacote.

Ainda sem decisão (detalhes em [`docs/roadmap.md`](docs/roadmap.md)):

| Tema | Por que importa |
| --- | --- |
| Provedor de e-mail | Convites e OTP; hoje só existe a interface e o log em desenvolvimento |
| Armazenamento de arquivos | Fotos de carta, avatar e comprovante de pagamento |
| Cobrança da assinatura da plataforma | O adendo mostra "forma de pagamento e faturas" |
| Segundo fator do administrador | Conta mais valiosa do sistema |
