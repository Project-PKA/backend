<!--
Título do PR em Conventional Commits — ele vira a mensagem do squash merge:
  feat(pedidos): adiciona cancelamento parcial
  fix(auth): trata token expirado como 401
O CI valida título, commits e nome da branch.
-->

## O que muda

<!-- Uma ou duas frases. -->

## Por que

<!-- O motivo. Se já está na issue, aponte para ela em vez de repetir. -->

Closes #

## Como testar

<!-- Passo a passo para o revisor validar. Inclua a requisição (curl/httpie)
     e o dado de seed que ela usa. -->

1.
2.

## Tipo de mudança

- [ ] `feat` — funcionalidade nova
- [ ] `fix` — correção de bug
- [ ] `refactor` — muda o código sem mudar comportamento
- [ ] `perf` — melhora performance
- [ ] `docs` — só documentação
- [ ] `test` — só testes
- [ ] `build` / `ci` / `chore` — infra e ferramentas

## Checklist do autor

- [ ] `make validate` passa localmente
- [ ] Testes cobrindo o comportamento novo ou o bug corrigido
- [ ] **Schema mudou?** Migration nova, numerada e reversível, **e** seed
      atualizado no mesmo PR (`docs/database.md`)
- [ ] **Contrato mudou?** `make openapi` rodado e `docs/api/openapi.yaml`
      commitado; endpoint novo sob `/v1/`
- [ ] Variável de ambiente nova em `.env.example`, na leitura validada de
      ambiente e nas variables do GitHub Environment
- [ ] Sem log de depuração, teste marcado como `only`/`skip`, ou TODO sem issue
- [ ] Documentação atualizada quando o comportamento mudou
      (`ARCHITECTURE.md`, `AGENTS.md`, `README.md`)

## Esta mudança toca em autenticação, dados sensíveis ou entrada externa?

<!-- Entrada externa = input do usuário, upload, webhook, chamada a API de terceiro. -->

- [ ] Sim — preencha o checklist OWASP abaixo
- [ ] Não — pode apagar a seção abaixo

### Checklist OWASP Top 10 ([SECURITY.md](../SECURITY.md))

- [ ] Controle de acesso: autorização verificada em todo endpoint novo ou alterado
- [ ] Dados sensíveis: criptografia em trânsito/repouso; nenhum segredo ou PII em log
- [ ] Injection: toda entrada externa validada; SQL só parametrizado/via ORM
- [ ] Design seguro: rate limiting, timeouts, limite de tamanho de payload
- [ ] Configuração: headers, CORS e permissões padrão restritivas
- [ ] Dependências novas sem vulnerabilidade conhecida
- [ ] Autenticação e sessão seguem o padrão do `ARCHITECTURE.md`
- [ ] Integridade: webhooks com assinatura verificada; artefatos com checksum
- [ ] Eventos de segurança logados de forma estruturada, sem dado sensível
- [ ] SSRF: nenhuma requisição a URL/host vindo de entrada externa sem allowlist

## Risco e rollback

**Risco:** <!-- baixo / médio / alto -->

**Como reverter:** <!-- reimplantar o SHA anterior basta? a migration tem down? precisa de flag? -->

## Precisa de aprovação humana explícita?

<!-- Marque se o PR toca algo da seção 6 do AGENTS.md. -->

- [ ] Muda schema com dado em produção (migration destrutiva, backfill)
- [ ] Muda autenticação, autorização ou gestão de secrets
- [ ] Muda o contrato de API de forma incompatível
- [ ] Muda workflow de CI/CD, permissão de token ou `project.mk`
- [ ] Adiciona ou remove dependência
- [ ] Afrouxa regra de qualidade (lint, cobertura, `skip`)
- [ ] Nada acima
