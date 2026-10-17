# Checklist de configuração manual

Tudo aqui **só pode ser feito pela interface do GitHub** (ou pela API/CLI).
Nenhum arquivo do repositório consegue configurar essas coisas sozinho.

- **Parte A:** no repositório TEMPLATE, uma única vez.
- **Parte B:** em cada projeto criado a partir dele.

Nomes de ambientes, secrets, variables e labels seguem o `CONVENCOES.md` do
`codex-base`. Em um projeto real, **apague este arquivo** depois de concluir
a Parte B.

---

# Parte A — no repositório template (uma vez)

## A1. Marcar como Template Repository

- [ ] **Settings → General → Template repository** → marcar

Sem isso, o botão **"Use this template"** não aparece, e as pessoas acabam
dando fork, o que herda issues, PRs e o vínculo com o upstream.

A marcação também muda o CI: no repositório template, os jobs que dependem
de stack (qualidade, testes, build, CodeQL, release, deploy) são pulados.
Convenções e o agente continuam rodando.

## A1.1 Pré-requisito: IgorOCosta/workflows público e com a tag `v1`

Os workflows daqui chamam `IgorOCosta/workflows/.github/workflows/*.yml@v1`.

- [ ] `IgorOCosta/workflows` é **público** (workflow reutilizável de repo
      privado não é visível para outras organizações)
- [ ] A tag `v1` existe no IgorOCosta/workflows (`git tag v1 && git push origin v1` na
      primeira vez; depois, a release do repositório de workflows move a tag sozinha)

## A2. Configuração geral

- [ ] **Settings → General → Pull Requests**
  - [ ] **Allow squash merging** marcado, com a mensagem padrão
        **Pull request title and description**
  - [ ] **Allow merge commits** desmarcado
  - [ ] **Allow rebase merging** desmarcado
  - [ ] **Automatically delete head branches** marcado

## A3. Permissões do Actions

- [ ] **Settings → Actions → General → Workflow permissions**
  - [ ] **Read repository contents and packages permissions**, só leitura.
        Os workflows pedem escrita por job, explicitamente.
  - [ ] **Allow GitHub Actions to create and approve pull requests**
        desmarcado. Release e contrato usam o `AUTOMATION_TOKEN` (B7).
- [ ] **Settings → Actions → General → Actions permissions**: permitir as
      actions da organização e mais estas:
      `IgorOCosta/workflows/*`, `actions/*`, `github/codeql-action/*`,
      `jdx/mise-action`, `SonarSource/*`, `docker/login-action`,
      `googleapis/release-please-action`, `peter-evans/create-pull-request`,
      além das da plataforma de deploy (`aws-actions/*`,
      `google-github-actions/*`, `azure/*`)

## A4. Segurança

- [ ] **Settings → Code security**
  - [ ] Dependency graph, Dependabot alerts e Dependabot security updates: ligados
  - [ ] Secret scanning e **Push protection**: ligados (bloqueiam commit com segredo)
  - [ ] CodeQL: **Advanced**. O `codeql.yml` já está no repositório; não use
        Default, que conflita.
  - [ ] **Private vulnerability reporting**: ligado (canal do `SECURITY.md`)

## A5. Validar antes de divulgar

- [ ] Criar um repositório de teste via **Use this template**
- [ ] Rodar o `BOOTSTRAP.md` e a Parte B inteira nele, com uma stack simples
- [ ] Abrir um PR de teste e conferir: `ci-success` aparece, o agente
      comenta, e a issue vinculada fecha no merge
- [ ] Rodar um deploy em `dev`
- [ ] Apagar o repositório de teste

---

# Parte B — em cada projeto criado do template

> Como cada projeto tem **a própria organização**, configure secrets e
> variables **no nível da organização** sempre que a tabela disser "org".
> O próximo repositório do projeto já nasce com tudo.

## B1. Bootstrap

- [ ] Criado por **Use this template → Create a new repository** (não fork)
- [ ] **Template repository desmarcado** no repositório novo. Se ficar
      marcado, o CI pula tudo.
- [ ] [`BOOTSTRAP.md`](BOOTSTRAP.md) concluído (as doze etapas)
- [ ] `make doctor` sem obrigatório pendente e sem placeholder

## B2. Substituir placeholders

`make doctor` lista os arquivos. Normalmente são estes:

- [ ] `.github/CODEOWNERS`: times reais (precisam ter acesso ao repositório)
- [ ] `.github/ISSUE_TEMPLATE/config.yml`: URLs de Discussions e Security
- [ ] `sonar-project.properties`: `organization`, `projectKey`, caminho de cobertura

## B3. Branch protection em `main`

**Settings → Rules → Rulesets → New branch ruleset**

- [ ] Target: `main` (ou: Default branch)
- [ ] **Restrict deletions** e **Block force pushes**
- [ ] **Require linear history**
- [ ] **Require a pull request before merging**
  - [ ] Required approvals: **1** (2 em time maior)
  - [ ] **Dismiss stale approvals when new commits are pushed**
  - [ ] **Require review from Code Owners**
  - [ ] **Require conversation resolution before merging**
- [ ] **Require status checks to pass**, com
      **Require branches to be up to date before merging**
  - [ ] Check obrigatório: **`ci-success`**, e só ele. Ele agrega
        convenções, qualidade, testes, build, contrato, imagem Docker e
        SonarCloud. **Não** adicione os jobs um a um.
  - [ ] Opcional: **Require code scanning results** (CodeQL)
- [ ] Bypass list vazia, ou só o time de plataforma

> Um check só aparece na lista depois de ter rodado ao menos uma vez.
> Abra um PR de teste antes de configurar esta seção.

## B4. GitHub Environments

**Settings → Environments → New environment.** Crie os quatro com
**exatamente** estes nomes, que o `deploy.yml` referencia: `dev`, `test`,
`homolog` e `prod`.

| Environment | Required reviewers | Deployment branches and tags |
| --- | --- | --- |
| `dev` | não | `main` |
| `test` | não | `main` |
| `homolog` | **sim** (1+) | `main` |
| `prod` | **sim** (2 recomendado) | `main` + tags `v*` |

**A aprovação de homologação e produção mora aqui**, não no YAML.

Variables e secrets **por environment**:

| Nome | Tipo | Uso |
| --- | --- | --- |
| `APP_BASE_URL` | variable | Smoke test (`GET /health`) e link do deployment |
| Configuração da aplicação (`DATABASE_URL`, chaves de terceiros...) | secret | Entregue em runtime pelo `scripts/deploy.sh`/plataforma |
| Credenciais da plataforma | secret/variable | Dependem da receita de [`DEPLOY.md`](DEPLOY.md) |

| Plataforma | Secrets | Variables |
| --- | --- | --- |
| Kubernetes | `KUBE_CONFIG` (ou OIDC da nuvem) | `KUBE_NAMESPACE`, `KUBE_DEPLOYMENT` |
| Google Cloud Run | — (OIDC) | `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SERVICE_ACCOUNT`, `CLOUD_RUN_SERVICE`, `GCP_REGION` |
| AWS ECS | `AWS_ROLE_ARN` | `AWS_REGION`, `ECS_CLUSTER`, `ECS_SERVICE` |
| AWS Lambda (container) | `AWS_ROLE_ARN` | `AWS_REGION`, `LAMBDA_FUNCTION` |
| VPS (docker compose via SSH) | `SSH_PRIVATE_KEY` | `SSH_HOST`, `SSH_USER` |

Repasse-os no passo `Publicar` do `.github/workflows/deploy.yml`.

- [ ] Os quatro environments criados, com **required reviewers** em
      `homolog` e `prod`
- [ ] `scripts/deploy.sh` implementado
- [ ] **Registry da imagem** (`DEPLOY.md`, "Registry da imagem"): sem nada
      configurado é o GHCR. Para ECR, a variable `IMAGE_REPOSITORY` e o secret
      `AWS_ECR_ROLE_ARN`; para outro registry, `IMAGE_REPOSITORY`,
      `REGISTRY_USERNAME` e `REGISTRY_PASSWORD`
- [ ] Depois do primeiro push em `main`, confira que a imagem existe no
      registry (no GHCR: *Packages*, com acesso do repositório)

> Prefira sempre **OIDC** a chave de longa duração. Em produção, restrinja a
> trust policy ao ambiente (`repo:ORG/REPO:environment:prod`): assim, a
> credencial só é obtida por um job que já passou pela aprovação.

## B5. SonarCloud

- [ ] Projeto criado em [sonarcloud.io](https://sonarcloud.io) e vinculado
- [ ] `sonar-project.properties` com `organization`, `projectKey` e o caminho
      de cobertura reais
- [ ] **Administration → Analysis Method → Automatic Analysis: DESLIGADO**.
      Ela conflita com a análise do CI.
- [ ] Secret `SONAR_TOKEN` **da organização**
- [ ] Quality Gate definido ("Sonar way" serve para começar)
- [ ] Dispensar o SonarCloud é uma decisão: `sonar: false` no `ci.yml`, com o
      motivo registrado em `STACK.md`

## B6. CodeQL

- [ ] Variable `CODEQL_LANGUAGES` do repositório (ex.: `python`, `go`,
      `java-kotlin`, `javascript-typescript`, `csharp`). **Sem ela, o CodeQL
      falha de propósito.**
- [ ] Linguagem compilada que precisa do build do projeto:
      `CODEQL_BUILD_MODE=manual` (usa `make build`)

## B7. AUTOMATION_TOKEN, GitHub Project e agente

Um único token da organização serve às automações que o `GITHUB_TOKEN` não
cobre: o GitHub Project, o PR de release (que precisa disparar o CI), a
release (que precisa disparar o deploy) e a publicação do contrato no
docs/shared.

- [ ] **Fine-grained PAT** com escopo **só na organização do projeto**,
      validade definida e lembrete de renovação. Permissões:
  - Repository: *Contents* RW, *Pull requests* RW, *Issues* RW, *Metadata* R
  - Organization: *Projects* RW
- [ ] Salvo como secret **`AUTOMATION_TOKEN` da organização**
- [ ] Project (v2) criado na organização, com a variable `PROJECT_URL` da
      organização
- [ ] Variable `COVERAGE_THRESHOLD` se a meta não for 70

> Mais seguro, quando valer o esforço: uma **GitHub App** da organização,
> com token de curta duração via `actions/create-github-app-token`.

## B8. Dependabot

`github-actions` e `docker` já vêm ativos.

- [ ] Descomentar o ecossistema de pacotes da stack em `.github/dependabot.yml`

## B9. Labels

O agente cria as labels na primeira vez que precisa delas. A lista canônica,
com cores, está no `CONVENCOES.md` do `codex-base` (seção 10). Ela é a mesma
em todos os repositórios, para o Project da organização agregar tudo.

## B9.1 Contrato de API (se o projeto tem docs/shared)

- [ ] Variable `CONTRACT_REPO` da organização = `org/repo` do docs/shared
- [ ] `OPENAPI_CMD` configurado e `docs/api/openapi.yaml` gerado e commitado
- [ ] Rodar **Actions → Publish contract → Run workflow** uma vez e conferir
      o PR `chore(contract): ...` no docs/shared

## B9.2 Release

- [ ] `release-type` da stack em `release-please-config.json`
- [ ] Depois do primeiro merge em `main`, conferir o PR
      `chore(main): release 0.1.0` aberto pelo release-please

## B10. Verificação final

- [ ] PR de teste a partir de `feature/teste-setup`
- [ ] `ci-success` verde; merge bloqueado sem aprovação
- [ ] Agente comentou convenções e cobertura
- [ ] `Closes #N` fechou a issue no merge
- [ ] Imagem publicada no GHCR e deploy em `dev` funcionando
- [ ] Deploy em `homolog` **parando na aprovação**
- [ ] **Apagar `SETUP-GITHUB.md` e `BOOTSTRAP.md`** e remover as referências
      a eles no `README.md`

---

## Resumo: secrets e variables

| Nome | Tipo | Nível | Obrigatório | Usado por |
| --- | --- | --- | --- | --- |
| `AUTOMATION_TOKEN` | secret | org | para Project, release e contrato | `github-agent`, `release`, `publish-contract` |
| `SONAR_TOKEN` | secret | org | sim, ou `sonar: false` | `ci` |
| `PROJECT_URL` | variable | org | para o Project | `github-agent` |
| `CONTRACT_REPO` | variable | org | se há docs/shared | `publish-contract` |
| `CODEQL_LANGUAGES` | variable | repo | **sim** | `codeql` |
| `CODEQL_BUILD_MODE` | variable | repo | não | `codeql` |
| `COVERAGE_THRESHOLD` | variable | repo | não (padrão 70) | `github-agent` |
| `IMAGE_REPOSITORY` | variable | repo ou org | não (padrão: GHCR) | `deploy` |
| `AWS_ECR_ROLE_ARN` | secret | repo ou org | se o registry for ECR | `deploy` |
| `REGISTRY_USERNAME` / `REGISTRY_PASSWORD` | variable / secret | repo ou org | se for outro registry | `deploy` |
| `APP_BASE_URL` | variable | environment | não (sem ela, não há smoke test) | `deploy` |

`GITHUB_TOKEN` é automático; não crie.

## Problemas comuns

| Sintoma | Causa provável |
| --- | --- |
| "workflow was not found" em `IgorOCosta/workflows/...@v1` | repositório de workflows privado, ou tag `v1` ainda não criada (A1.1) |
| Todos os jobs do CI aparecem como pulados | O repositório ainda está marcado como *Template repository* (B1) |
| CI falha com "FALTA CONFIGURAR" | Variável vazia em `project.mk`: rode `make doctor` |
| "Contrato desatualizado" | O código mudou a API e `make openapi` não foi commitado |
| "Dockerfile ausente" | `docker/Dockerfile.example` ainda não copiado para a raiz |
| "CodeQL sem linguagem" | Falta a variable `CODEQL_LANGUAGES` (B6) |
| "SonarCloud nao configurado" | Falta o secret `SONAR_TOKEN` (B5) |
| Deploy: "Imagem inexistente" | Tentativa de promover um SHA que nunca foi construído por push em `main` |
| Deploy falha em "DEPLOY NAO IMPLEMENTADO" | `scripts/deploy.sh` ainda é o stub: ver `DEPLOY.md` |
| PR de release não roda o CI | Release usando `GITHUB_TOKEN`: configure `AUTOMATION_TOKEN` (B7) |
| Release não dispara o deploy em `prod` | Mesma causa: release criada com `GITHUB_TOKEN` |
| Agente não comenta no PR | PR de fork ou do Dependabot: token somente leitura, por design |
