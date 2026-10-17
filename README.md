# template-backend

Repositório **template**: a fundação de qualidade, CI/CD, segurança e
documentação que todo backend deve ter desde o primeiro commit.

**Sem stack.** Não há linguagem, framework, ORM nem plataforma de deploy
escolhida aqui. Isso é decidido no projeto novo, com o contexto do projeto
novo. O que existe é tudo o que normalmente só aparece no terceiro mês,
quando já é tarde: CI, convenções, governança, automação, deploy com
promoção de imagem e os esqueletos de documentação.

---

## Como isso funciona sem stack

A fundação conversa com a stack por um **contrato de comandos**:

```
  CI, hooks, documentação
            │
            │  make setup · make lint · make test · make build · make openapi
            ▼
      Makefile            ← contrato. Você não edita.
            │
            ▼
      project.mk          ← os comandos reais. O único acoplamento com a stack.
            │
            ▼
   npm · uv · go · gradle · dotnet · o que for
```

Nenhum workflow sabe qual é a sua stack. Um alvo ainda não configurado
**falha com instrução explícita**, e um alvo que não se aplica recebe `skip`,
que é uma decisão registrada, não um esquecimento:

```
$ make lint

FALTA CONFIGURAR: LINT_CMD

  Defina LINT_CMD em project.mk
  Nao se aplica a este projeto? use:  LINT_CMD = skip
```

---

## Como usar

1. No GitHub: **Use this template → Create a new repository**. Não use fork:
   ele mantém vínculo com o template, herda issues e PRs e aparece como
   "forked from".
2. Clone o repositório novo e peça ao agente de IA (ou siga sozinho):

   ```
   Leia o BOOTSTRAP.md e me conduza pelas etapas.
   ```

   Abra o Claude Code **dentro deste repositório**, com o docs/shared do
   projeto clonado ao lado e acessível (no terminal:
   `claude --add-dir ../<projeto>-shared`). O `CLAUDE.md` daqui é carregado
   no início, e o agente lê as decisões de sistema de lá.

   O [`BOOTSTRAP.md`](BOOTSTRAP.md) é um roteiro de doze etapas: contexto,
   escala, stack, banco e seeds, qualidade, testes, autenticação, secrets,
   observabilidade, contrato de API, deploy e fechamento. Em cada uma, ele
   diz **o que perguntar** e **onde registrar a resposta**.
3. Acompanhe com `make doctor`: ele mostra o que foi decidido, o que foi
   dispensado (`skip`), o que falta e os placeholders restantes.
4. Configure o GitHub com o [`SETUP-GITHUB.md`](SETUP-GITHUB.md): Environments,
   branch protection, secrets da organização. Nenhum arquivo faz isso por você.

Depois do bootstrap, o [`AGENTS.md`](AGENTS.md) descreve o projeto real:
comandos, convenções e o que exige aprovação humana. Este README não duplica
esse conteúdo.

---

## O que vem pronto

**CI/CD**

- Um único check de merge (`ci-success`) agregando convenções, formato,
  lint, tipos, testes com cobertura, build, **contrato de API em dia com o
  código**, build da imagem Docker e SonarCloud com Quality Gate
- **Build once, deploy many**: a imagem é construída uma vez no push em
  `main` (GHCR, tag = SHA) e promovida para `dev` → `test` → `homolog` →
  `prod`, com aprovação nos dois últimos. Rollback é reimplantar o SHA anterior.
- Publicação isolada em `scripts/deploy.sh`, com receitas para Kubernetes,
  Cloud Run, ECS e VPS em [`DEPLOY.md`](DEPLOY.md)
- Versão e CHANGELOG automáticos (release-please); a release dispara o
  deploy em `prod`
- CodeQL em PR, push e semanalmente; Dependabot para Actions e Docker

**Contrato de API**

- `docs/api/openapi.yaml` gerado **do código** (`make openapi`); o CI falha
  se o arquivo divergir
- No merge, `publish-contract.yml` abre um PR com o contrato no docs/shared
  do projeto, e de lá os consumidores regeneram os tipos

**Banco de dados**

- Postgres local desde o dia 1 (`docker compose up -d db`)
- Regras de ORM (schema versionado + type safety), migrations
  (expandir → contrair) e seeds cobrindo todos os estados:
  [`docs/database.md`](docs/database.md)

**Governança e automação**

- Conventional Commits e nome de branch validados em **shell puro**, nas
  mesmas regras, no hook local e no CI
- Templates de issue e de PR (com checklist OWASP para mudança sensível),
  CODEOWNERS
- Agente do GitHub: rotula issues, adiciona ao Project, comenta o
  diagnóstico do PR e a cobertura, fecha issues vinculadas

**Documentação viva**

| Arquivo | Para que serve |
| --- | --- |
| [`AGENTS.md`](AGENTS.md) | Contexto para pessoas e agentes. **Comece por aqui.** |
| [`BOOTSTRAP.md`](BOOTSTRAP.md) | Roteiro de decisões do projeto novo |
| [`SETUP-GITHUB.md`](SETUP-GITHUB.md) | O que só dá para fazer na interface do GitHub |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Camadas, C4, ERD, auth, secrets, observabilidade, contrato |
| [`STACK.md`](STACK.md) | Por que cada escolha foi feita |
| [`TESTING.md`](TESTING.md) | Estratégia de testes |
| [`DEPLOY.md`](DEPLOY.md) | Ambientes, promoção de imagem e receitas por plataforma |
| [`SECURITY.md`](SECURITY.md) | Report de vulnerabilidade e checklist OWASP |
| [`docs/database.md`](docs/database.md) | ORM, migrations e seeds |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Fluxo de contribuição |

---

## Requisitos

| Ferramenta | Para que | Obrigatório |
| --- | --- | --- |
| `git` | — | Sim |
| `make` | Contrato de comandos | Sim |
| Docker | Banco local e imagem | Sim |
| `mise` ou `asdf` | Instalar o runtime de `.tool-versions` | Recomendado |

**Windows:** `make` não vem instalado: `winget install ezwinports.make` (ou
WSL). Os hooks e validadores rodam em `sh` e funcionam no Git Bash.

---

## Manutenção do template

Entra aqui: workflow, esqueleto de documentação, regra, receita de deploy,
exemplo em `project.mk`. **Não entra:** stack, framework, ORM, dependência,
plataforma de deploy fixa.

As convenções (branches, ambientes, labels, secrets) são as do
`CONVENCOES.md` do `codex-base`. Este template as implementa, não as define.
O que é política comum (CI, convenções, agente, release) mora nos workflows
centrais (`IgorOCosta/workflows`) e chega a todos os projetos pela tag `v1`. O resto
é cópia: projetos já criados não recebem atualização automática.
