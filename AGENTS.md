# AGENTS.md

> **Este arquivo pertence a um repositório TEMPLATE.**
>
> Se você está lendo isto dentro de um projeto criado a partir do template
> — ou seja, o repositório tem nome próprio, tem produto, tem gente usando —
> então **este arquivo está desatualizado por definição**, e reescrevê-lo é a
> sua primeira tarefa.

---

## Para agentes de IA: leia isto antes de qualquer coisa

### Se este repositório ainda É o template

Você está no `template-backend`: a fundação de qualidade, CI/CD, segurança e
documentação que todo backend recebe no primeiro commit.

Ele **não tem stack**. Não há linguagem, framework, ORM ou plataforma de
deploy escolhida, e isso é intencional, não uma lacuna. A fundação conversa
com a stack por um contrato de comandos (`Makefile` + `project.mk`).

Regras aqui:

- **Não adicione stack.** Nada de `package.json`, `pyproject.toml`, `go.mod`,
  framework ou ORM. Se a mudança amarra o template a uma tecnologia, ela não
  pertence a este repositório.
- **Não adicione funcionalidade de produto.** Nenhum endpoint de negócio,
  nenhum domínio.
- Mudanças válidas: melhorar um workflow, um esqueleto de documentação, uma
  regra; acrescentar uma receita a `DEPLOY.md` ou um exemplo a `project.mk`.
- Convenções (branches, ambientes, labels, secrets) vêm do `CONVENCOES.md`
  do `codex-base`. Não invente outras aqui.
- Ao mexer aqui, pense no efeito em **todos** os projetos futuros.

### Se este repositório FOI CRIADO a partir do template

**Antes de escrever qualquer código, conduza o bootstrap:**
[`BOOTSTRAP.md`](BOOTSTRAP.md). Ele traz as etapas de decisão (contexto,
stack, banco, autenticação, secrets, contrato de API, deploy...), o que
perguntar em cada uma e onde registrar a resposta.

Rode `make doctor` primeiro: ele mostra o que já foi decidido e o que falta.

**A última etapa do bootstrap é reescrever este arquivo** com o conteúdo real
do projeto, seguindo o modelo abaixo. Este arquivo é o contexto que todo
agente lê primeiro: enquanto ele falar do template, cada agente começa com a
premissa errada.

Como fazer: apague tudo acima da linha `<!-- INICIO DO MODELO -->`, preencha
o modelo, apague os comentários de instrução e commite sozinho
(`docs: define AGENTS.md do projeto`).

Enquanto este arquivo não for reescrito, um agente deve **avisar quem pediu a
tarefa** e oferecer a reescrita antes de seguir.

### Faxina do primeiro commit

| Arquivo | O que fazer |
| --- | --- |
| `AGENTS.md` | Reescrever (este arquivo) |
| `README.md` | Reescrever para o produto |
| `BOOTSTRAP.md`, `SETUP-GITHUB.md` | Apagar depois de concluir |
| `project.mk` | Preencher; remover os blocos de exemplo que não usar |
| `.tool-versions` | Fixar a versão do runtime |
| `STACK.md`, `ARCHITECTURE.md`, `TESTING.md`, `DEPLOY.md` | Preencher os esqueletos |
| `docker/Dockerfile.example` | Copiar para `./Dockerfile`, preencher e apagar a pasta `docker/` |
| `docs/api/openapi.yaml` | Passar a ser gerado por `make openapi` |
| `.github/CODEOWNERS`, `.github/ISSUE_TEMPLATE/config.yml` | Trocar os placeholders de organização e repositório (`make doctor` lista) |
| `sonar-project.properties` | Organization, projectKey, caminho de cobertura |
| `release-please-config.json` | Trocar `release-type` pelo da stack |
| `scripts/deploy.sh` | Implementar com a receita de `DEPLOY.md` |

**Não remova:** `Makefile`, `.githooks/`, `scripts/conventions.sh` e os
validadores, os workflows, `CLAUDE.md`, `.editorconfig`, `.gitattributes`,
os arquivos do release-please.

---

<!-- INICIO DO MODELO — em um projeto real, tudo acima disto sai -->

## Estrutura obrigatória do AGENTS.md do projeto

As sete seções abaixo são obrigatórias, nesta ordem. O conteúdo entre
`<!-- -->` é instrução de preenchimento e deve ser apagado.

---

### 1. Visão geral

<!--
Em até 10 linhas, o que um dev novo (ou um agente sem contexto) precisa saber
antes de tocar em qualquer arquivo:
  - O que este serviço faz e para quem (quem consome a API).
  - O papel DESTE repositório no sistema (quais serviços chama, quem depende dele).
  - Em que estágio está: protótipo, produção, legado em manutenção.
  - O que NÃO está aqui e as pessoas costumam procurar aqui.

Mantenha SEMPRE a linha do docs/shared abaixo (ou diga que não há):
-->

**docs/shared do projeto:** <!-- org/repo, ou "não há" -->. Antes de decisão de
arquitetura ou de contrato de API, leia o `ARCHITECTURE.md`, as ADRs
(`docs/adr/`) e o `GLOSSARY.md` de lá, de preferência clonado ao lado deste
repositório (`../<nome-do-shared>`). Se não estiver clonado, peça para clonar.
O contrato publicado lá é **gerado daqui** (`make openapi`): não o edite no
shared.

### 2. Comandos

Todos os comandos passam pelo contrato do `Makefile`. Os comandos reais de
cada alvo ficam em `project.mk`, e é lá que se troca de ferramenta.

| Comando | O que faz | Observação |
| --- | --- | --- |
| `make setup` | Instala dependências e ativa os hooks | Primeira coisa após o clone |
| `docker compose up -d db` | Sobe o banco local | |
| `make migrate` / `make seed` | Aplica migrations / popula o banco | |
| `make run` | Sobe a API | <!-- porta --> |
| `make build` | Compila/empacota | |
| `make lint` | Análise estática (inclui code smells) | `make lint-fix` corrige |
| `make format` | Formata | `make format-check` só verifica |
| `make typecheck` | Checagem de tipos | |
| `make test` | Testes unitários e de integração | `make test-watch` em watch |
| `make test-coverage` | Testes com cobertura | Mínimo <!-- % --> |
| `make migration NAME=...` | Cria migration nova | Atualize o seed no mesmo PR |
| `make openapi` | Gera `docs/api/openapi.yaml` do código | Commite o resultado |
| `make validate` | Formato + lint + tipos + testes | **Rode antes de abrir PR** |
| `make doctor` | O que está configurado e o que falta | |

<!--
Ajuste a tabela: remova as linhas dos alvos marcados como `skip` em
project.mk e anote porta e meta de cobertura reais.
-->

**Windows:** `make` não vem instalado. Use WSL, ou
`winget install ezwinports.make`.

### 3. Convenções

<!--
Regras que um agente deve seguir sem perguntar. Escreva as que o projeto
realmente segue; apague as que não valerem. Prefira regra verificável a
princípio abstrato. Sugestões do que cobrir:

**Camadas** — o que mora em cada camada (ARCHITECTURE.md), quem pode importar
  quem. (Transforme em regra de lint/arquitetura quando der.)
**API** — endpoints de negócio sob /v1/; /health e /ready fora da versão;
  formato de erro padrão; paginação.
**Banco** — migration numerada e reversível; seed atualizado no mesmo PR;
  nada de SQL concatenado.
**Logs** — JSON estruturado com trace_id; nunca segredo ou PII.
**Configuração** — leitura de ambiente em um único módulo, validada no boot.
**Testes** — onde ficam; factories em vez de fixture compartilhada.
-->

### 4. Regras de commit e PR

**Branches:** `feature/`, `fix/`, `hotfix/`, `release/`, `chore/`, `docs/`,
`refactor/` ou `test/` + slug em minúsculas. Por exemplo,
`feature/cancelamento-parcial`.

**Commits:** [Conventional Commits](https://www.conventionalcommits.org),
`tipo(escopo): descrição no imperativo`.

```
feat(pedidos): adiciona cancelamento parcial
fix(auth): trata token expirado como 401
feat(api)!: remove o campo legado de resposta
```

Tipos: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`,
`ci`, `chore`, `revert`.

As regras vivem em `scripts/conventions.sh` (hooks locais), que é uma cópia
das regras centrais de IgorOCosta/workflows usadas pelo CI.

**Pull requests**

- O título também segue Conventional Commits, porque vira a mensagem do
  squash merge e alimenta o CHANGELOG e a versão (release-please).
- Preencha o template inteiro.
- Vincule a issue com `Closes #N`.
- PR pequeno. Refatoração ampla vai separada da mudança de comportamento.
- Merge só com `ci-success` verde e aprovação de CODEOWNER.

### 5. Checklist de conclusão de tarefa

Uma tarefa **não está pronta** enquanto todos os itens abaixo não forem
verdade. Rode os comandos; não suponha o resultado.

- [ ] `make validate` passa
- [ ] Teste novo cobrindo o comportamento adicionado ou o bug corrigido
- [ ] Schema mudou: migration reversível **e** seed atualizado
- [ ] Contrato mudou: `make openapi` rodado e o arquivo commitado
- [ ] Variável de ambiente nova documentada onde a seção 3 exige
- [ ] Nenhum log de depuração, teste `only`/`skip`, ou segredo no código
- [ ] Documentação atualizada quando o comportamento ou a arquitetura mudou
- [ ] Mensagem de commit e nome de branch nos padrões da seção 4

Se algum item não se aplica, diga na descrição do PR por quê.

### 6. Pontos que exigem aprovação humana

Um agente **para e pergunta** antes de fazer qualquer coisa desta lista.
Propor o diff e explicar o motivo está liberado; aplicar sem confirmação, não.

- Migration destrutiva ou com dado em produção (drop, rename, backfill)
- Mudança em autenticação, autorização ou gestão de secrets
- Mudança **incompatível** no contrato de API
- Adicionar, remover ou trocar dependência
- Mudar `project.mk` de forma que altere o que o CI executa
- Mudar `.github/workflows/**`, permissão de token ou regra de deploy
- Rodar deploy para `homolog` ou `prod`
- Afrouxar regra de qualidade (lint, cobertura, `skip`)
- `git push --force`, reescrita de histórico, mexer em branch protegida
- Apagar teste, ou marcá-lo como `skip` para fazer o CI passar
- Qualquer coisa que envolva dado real de usuário

**Regra geral:** se o erro sai caro, sai em produção ou é difícil de
reverter, pergunte primeiro.

### 7. Armadilhas conhecidas

<!--
A seção mais útil com o tempo. Registre o que já fez alguém (ou algum agente)
perder uma tarde. Uma linha por armadilha. Comece vazio e vá preenchendo.
-->

- <!-- -->

---

## Como a fundação funciona (referência)

| Peça | Papel |
| --- | --- |
| `Makefile` | Contrato de comandos. Não se edita. |
| `project.mk` | Os comandos reais. **O único ponto de acoplamento com a stack.** |
| `scripts/conventions.sh` | Regras de branch e commit dos hooks (cópia das centrais) |
| `.githooks/` | Hooks versionados, sem dependência de runtime |
| `scripts/deploy.sh` | O único lugar que sabe onde a imagem roda |
| `.github/workflows/ci.yml` | Portão de merge (`ci-success`). Falha e bloqueia. |
| `.github/workflows/deploy.yml` | Build único da imagem e promoção entre ambientes |
| `.github/workflows/publish-contract.yml` | Publica `docs/api/openapi.yaml` no docs/shared |
| `.github/workflows/release.yml` | Versão e CHANGELOG a partir dos commits |
| `.github/workflows/github-agent.yml` | Feedback: rotula, comenta, organiza. Nunca bloqueia. |
| `IgorOCosta/workflows` (`@v1`) | Onde mora a lógica dos workflows e as regras centrais |
| `CLAUDE.md` | Uma linha (`@AGENTS.md`): o Claude Code carrega este arquivo |

**Um alvo `skip` em `project.mk` é uma decisão registrada**, revisitável,
e não um esquecimento. `make doctor` mostra os três estados (configurado,
`skip`, pendente).
