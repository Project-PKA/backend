# Bootstrap do projeto

> ⚠️ **Arquivo temporário.** Existe só até o setup inicial terminar. A etapa 12
> o apaga, junto com o `SETUP-GITHUB.md`, em um commit próprio.

Roteiro para transformar este template em um backend real. Serve para uma
pessoa sozinha e serve como **instrução de trabalho para um agente de IA**
(Claude Code ou equivalente).

> **Para o agente:** este documento é a sua tarefa enquanto o repositório
> estiver em estado de template. Siga as etapas na ordem. Em cada uma: **faça
> as perguntas, espere a resposta, registre a decisão no arquivo indicado, e
> só então avance.** Não escolha stack, banco, ORM ou plataforma por conta
> própria, mesmo que a escolha pareça óbvia. Você pode e deve **recomendar**,
> com o trade-off explícito, mas a decisão é de quem pediu.
>
> **Não gere código de negócio antes da etapa 12.** As etapas 3 a 11 só
> produzem configuração, esqueleto e o mínimo verificável (health check,
> primeira migration, primeiro teste).

**Como começar, no projeto novo:**

```
Leia o BOOTSTRAP.md e me conduza pelas etapas.
```

---

## Estado atual do repositório

Antes de perguntar qualquer coisa, rode:

```bash
make doctor
```

Ele mostra o que já foi decidido e o que falta, e os placeholders que sobram.
`nao configurado` significa decisão pendente; `(skip)` significa decisão
tomada de não usar.

O que **já** existe e não precisa ser decidido:

| Área | Estado |
| --- | --- |
| Convenções de branch e commit | Prontas, validadas em hook e no CI |
| Governança (issues, PR, CODEOWNERS) | Pronta, falta trocar os placeholders |
| CI (qualidade, testes, build, contrato, imagem, SonarCloud) | Pronto, falta preencher `project.mk` |
| Agente do GitHub | Pronto |
| Release (versão + CHANGELOG) | Pronto, falta o `release-type` |
| Deploy: build único, ambientes e aprovação | Prontos, falta a plataforma |
| Publicação do contrato no docs/shared | Pronta, falta apontar o shared |
| Banco local (Postgres no `compose.yaml`) | Pronto: `docker compose up -d db` |
| Esqueletos de documentação | Prontos, faltam as decisões |

O que **não** existe, de propósito: linguagem, framework, ORM, ferramentas de
teste, plataforma de deploy, código.

---

## Etapa 1 — Contexto

**Pergunte:**

1. O que este serviço faz, e quem consome a API? (frontend próprio, parceiro
   externo, outros serviços)
2. Em que estágio está: protótipo descartável, produto novo indo para
   produção, ou substituição de algo existente?
3. Quem mantém: uma pessoa, um time, vários times?
4. Existe um repositório **docs/shared** no projeto? Qual (`org/repo`)?
5. Restrições da organização: stack padronizada, nuvem obrigatória,
   compliance (LGPD, PCI), auditoria?

A resposta 2 muda quase tudo o que vem depois. Um protótipo de duas semanas
não precisa de OpenTelemetry nem de homologação com aprovação; um produto de
longa duração precisa dos dois desde cedo.

**Registre em:** `AGENTS.md` seção 1 (inclusive a linha do docs/shared) ·
`ARCHITECTURE.md` "Visão geral" · `README.md`

---

## Etapa 2 — Volume, escala e requisitos

**Pergunte:**

1. Quantas requisições por segundo, quantos usuários, quanto dado, hoje e em
   um ano?
2. Latência máxima aceitável e disponibilidade exigida (SLA)?
3. Integrações obrigatórias: filas, e-mail, pagamento, APIs de terceiros?
4. Precisa de processamento assíncrono? Se sim, é candidato a
   **microservice** (template próprio), e não a thread dentro desta API?

"Escalar horizontalmente desde o dia 1" quase sempre é prematuro. Registre
o número real e o gatilho que obrigaria a revisitar.

**Registre em:** `ARCHITECTURE.md` "Visão geral" e "Decisões" · `STACK.md`
(critério de cada escolha)

---

## Etapa 3 — Stack

**Pergunte:**

1. Que linguagem o time domina? (a resposta honesta costuma ser a certa)
2. Há padrão na organização?
3. Framework HTTP: o que o ecossistema oferece com **geração de OpenAPI a
   partir do código** (requisito da etapa 10)?

**Não recomende por moda.** Os critérios que valem: quem vai manter, o que já
existe na organização, e o ferramental de qualidade disponível. Este
template exige lint com code smells, cobertura em `coverage/`, geração de
OpenAPI e ORM com type safety.

**Depois de decidir, o agente deve:**

1. Inicializar o projeto com a ferramenta oficial da stack. Não escreva à
   mão o que um scaffolder faz melhor.
2. Preencher `.tool-versions` com a versão exata do runtime.
3. Preencher em `project.mk`: `SETUP_CMD`, `RUN_CMD`, `BUILD_CMD`,
   `CLEAN_CMD`, `BUILD_DIR`.
4. Descomentar o bloco da stack em `.gitignore` e o ecossistema em
   `.github/dependabot.yml`.
5. Rodar `make setup && make build` e confirmar que passa.
6. Commitar o lockfile.

**Registre em:** `STACK.md` seções 1 e 2 · `AGENTS.md` seção 2

---

## Etapa 4 — Banco de dados, ORM e seeds

**Pergunte:**

1. Qual banco? (Postgres é o padrão do `compose.yaml`; troque se preciso)
2. Qual ORM/migration? Leia os critérios em [`docs/database.md`](docs/database.md):
   **migration numerada e reversível** + **tipos gerados do schema**.
3. O banco é compartilhado com outro serviço? Se sim, quais tabelas ele
   acessa e com que permissão? As migrations continuam só aqui.
4. Quais entidades e **estados** o seed precisa cobrir?

**Depois de decidir:**

1. Ajustar o serviço `db` do `compose.yaml` e o `DATABASE_URL` do
   `.env.example`, se o banco não for Postgres.
2. Preencher `MIGRATE_CMD`, `MIGRATION_CMD` e `SEED_CMD`.
3. Criar a primeira migration e um seed mínimo **com mais de um estado**:
   `docker compose up -d db && make migrate && make seed`.

**Registre em:** `STACK.md` seção 3 · `ARCHITECTURE.md` "Diagrama ERD" e
"Banco compartilhado"

---

## Etapa 5 — Qualidade

Não há o que perguntar sobre **se** haverá lint e formatação: o CI exige.
A pergunta é **com que ferramentas**.

| Requisito | Por quê | Exemplos |
| --- | --- | --- |
| Erros de programação | O básico | ESLint, ruff, golangci-lint |
| **Code smells / complexidade** | Alimenta o Quality Gate | `eslint-plugin-sonarjs`, regras C90/PL do ruff, `gocognit` |
| Formatação separada do lint | Formatação não é discussão de review | Prettier, `ruff format`, `gofmt` |
| Tipos | Contrato com o ORM e com a API | `tsc`, mypy/pyright; `skip` em linguagem compilada |

**Preencher em `project.mk`:** `LINT_CMD`, `LINT_FIX_CMD`, `FORMAT_CMD`,
`FORMAT_CHECK_CMD`, `TYPECHECK_CMD`.

Depois: `make validate` e um `git commit` de teste (para exercitar os hooks).

**Registre em:** `STACK.md` seção 4 · `AGENTS.md` seção 3

---

## Etapa 6 — Testes

**Pergunte:**

1. Framework de testes? (o padrão do ecossistema)
2. Testes de integração com banco **real** em container? (recomendado) Como
   ele sobe no CI?
3. Qual o piso de cobertura? (70% é um começo razoável; importa mais existir
   e não cair)
4. Teste de contrato contra `docs/api/openapi.yaml`? (Schemathesis, Dredd)

**Requisito técnico:** `TEST_COVERAGE_CMD` grava em `coverage/`, com
`lcov.info` de preferência (o comentário de cobertura no PR lê esse
formato). Aponte o caminho real em `sonar-project.properties`.

**Preencher em `project.mk`:** `TEST_CMD`, `TEST_WATCH_CMD`, `TEST_COVERAGE_CMD`.

Escreva ao menos um teste de verdade antes de seguir, nem que seja
"GET /health devolve 200". Um `make test` que passa sem testar nada dá
falsa segurança.

**Registre em:** `TESTING.md` · `STACK.md` seção 5

---

## Etapa 7 — Autenticação e autorização

**Pergunte:**

1. O serviço autentica usuários diretamente, ou confia em um identity
   provider/gateway (Auth0, Cognito, Keycloak, Entra ID)?
2. Sessão: JWT stateless ou sessão em banco/Redis? Onde fica o refresh
   token?
3. Modelo de permissão: RBAC (papéis) ou ABAC (atributos)? A maioria dos
   projetos pequenos e médios resolve com RBAC simples.
4. Se houver microservices: como a identidade viaja entre eles (token
   repassado, token de serviço, mTLS)?

Retrofit de autenticação depois é sempre doloroso: decida agora, mesmo que
a implementação venha depois.

**Registre em:** `ARCHITECTURE.md` "Autenticação e autorização" · ADR em
`docs/adr/` se a decisão for cross-repo (então vai para o docs/shared)

---

## Etapa 8 — Secrets em produção

**Pergunte:**

1. Onde as credenciais vão viver? Projeto pequeno: secrets do GitHub
   Environment, injetados no deploy. Múltiplos serviços puxando os mesmos
   segredos: cofre (Doppler, AWS Secrets Manager, Vault).
2. Quem tem acesso, e como é a rotação?

**Nunca configure secret de produção sozinho.** Liste o que é preciso e peça
para a pessoa criar.

**Registre em:** `ARCHITECTURE.md` "Gestão de secrets"

---

## Etapa 9 — Observabilidade

Não é opcional; a pergunta é **com quê**.

| Item | Requisito | Onde |
| --- | --- | --- |
| Health check | `GET /health` (liveness) e `GET /ready` (readiness, checa o banco), fora de `/v1` e sem auth | Implementar agora |
| Logs | JSON estruturado, uma linha por evento, com `trace_id` | Lib da stack |
| Métricas | `/metrics` no formato Prometheus | Lib da stack |
| Tracing | OpenTelemetry, `trace_id` propagado em headers | SDK + `OTEL_*` do `.env.example` |

**Pergunte:** onde isso é coletado e visualizado? (Grafana, Datadog, a nuvem)

**Registre em:** `ARCHITECTURE.md` "Observabilidade" · `STACK.md` seção 6

---

## Etapa 10 — Contrato de API

O contrato é **gerado do código** e publicado no docs/shared
(`ARCHITECTURE.md`, "Contrato de API").

1. Configure a geração: `OPENAPI_CMD` em `project.mk` escreve
   `docs/api/openapi.yaml`.
2. Rode `make openapi` e commite o resultado. A partir daqui, o CI falha se
   o arquivo divergir do código.
3. Endpoints de negócio sob `/v1/`.
4. **Com docs/shared** (etapa 1): peça para configurar a variable
   `CONTRACT_REPO` da organização (`SETUP-GITHUB.md` B9.1). No próximo merge
   que mudar o contrato, o `publish-contract.yml` abre o PR lá.
5. Sem API HTTP (improvável, mas possível): `OPENAPI_CMD = skip` e remova
   `contract-path` do `ci.yml`.

**Registre em:** `ARCHITECTURE.md` "Contrato de API"

---

## Etapa 11 — Container e deploy

**Pergunte:**

1. Onde a organização já hospeda? (integrar ao que existe vence quase sempre)
2. Restrição de nuvem, região ou soberania de dados?
3. Quem opera em produção?
4. Como as migrations rodam no deploy (job antes da troca de versão,
   initContainer, passo do script)?

**Depois de decidir:**

1. `cp docker/Dockerfile.example Dockerfile`, preencher e validar com
   `docker compose --profile app up --build`.
2. Copiar a receita de [`DEPLOY.md`](DEPLOY.md) para `scripts/deploy.sh`,
   incluindo as migrations.
3. Repassar os secrets/variables no passo `Publicar` do `deploy.yml`.
4. Pedir para configurar a variable `CODEQL_LANGUAGES` (e
   `CODEQL_BUILD_MODE=manual` se a linguagem compilada precisar de
   `make build`).
5. Seguir `SETUP-GITHUB.md` B4 para os quatro Environments.
6. Rodar um deploy em `dev` e confirmar o smoke test.
7. Preencher a seção de rollback do `DEPLOY.md`.

**Registre em:** `DEPLOY.md` · `STACK.md` seção 7

---

## Etapa 12 — Fechamento

Nesta ordem. A ordem importa: o `AGENTS.md` só é escrito quando os comandos
que ele descreve **já rodam**.

1. **Confira os esqueletos:** `STACK.md`, `ARCHITECTURE.md` (com os
   diagramas C4 e ERD reais), `TESTING.md` e `DEPLOY.md`, sem `A DECIDIR`
   que não seja adiamento consciente.
2. **Release:** troque `release-type` em `release-please-config.json` pelo da
   stack (`node`, `python`, `go`, `java`...) e apague `version.txt` se o tipo
   novo não usar.
3. **Troque os placeholders** até `make doctor` não listar nenhum:
   `SUA-ORG`/`SEU-REPOSITORIO` em `.github/CODEOWNERS`,
   `.github/ISSUE_TEMPLATE/config.yml` e `sonar-project.properties`.
4. **Rode o critério de pronto** abaixo.
5. **Reescreva o `AGENTS.md`**, apagando tudo que fala do template e
   preenchendo as sete seções com a realidade do projeto e os comandos que
   você acabou de ver passar.
6. **Reescreva o `README.md`** para o produto.
7. **Rode `SETUP-GITHUB.md` parte B**: branch protection, Environments,
   SonarCloud, `AUTOMATION_TOKEN`, Project, contrato.
8. **Apague** `BOOTSTRAP.md` e `SETUP-GITHUB.md` em um commit próprio
   (`chore: remove roteiros de bootstrap`).
9. **Abra um PR de teste** e confirme, de ponta a ponta: CI verde, agente
   comentando, merge bloqueado sem aprovação, issue fechando por `Closes #N`,
   PR de release aberto depois do merge, deploy em `dev`.

### Critério de pronto

```bash
make doctor                  # nenhum obrigatório pendente, nenhum placeholder
make validate                # passa
make build && make openapi   # passa, e git status limpo
docker build -t api:local .  # passa
```

- [ ] `AGENTS.md` fala do projeto, não do template
- [ ] Todo `skip` em `project.mk` é uma decisão registrada na documentação
- [ ] Primeira migration e seed com mais de um estado por entidade
- [ ] `GET /health` e `GET /ready` respondem
- [ ] Deploy para `dev` funcionou de verdade; `homolog` para na aprovação
- [ ] `BOOTSTRAP.md` e `SETUP-GITHUB.md` apagados

Só depois disso comece o código de negócio.

---

## Regras para o agente durante o bootstrap

- **Uma etapa por vez.** Não despeje as perguntas todas de uma vez.
- **Recomende com trade-off, nunca decida.** "Eu sugiro X porque Y, mas custa
  Z", e então espere a resposta.
- **Registre antes de avançar.** Decisão que não foi escrita em arquivo não
  aconteceu.
- **Rode o que você configurou.** Depois de preencher `project.mk`, execute o
  alvo. Não declare pronto sem ter visto passar.
- **`skip` é decisão, não atalho.** Nunca use `skip` para fazer o CI ficar verde.
- **Não afrouxe a fundação para caber na stack.** Se uma regra do template
  atrapalha de verdade, diga qual e por quê, e deixe a pessoa decidir.
- **Pare e pergunte** em tudo que estiver na seção 6 do `AGENTS.md`:
  secrets, workflows, deploy em ambiente real, dependência nova.
