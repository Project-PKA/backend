# Política de segurança

## Reportando uma vulnerabilidade

**Não abra issue pública.** Use
[Security → Report a vulnerability](../../security/advisories/new) (GitHub
Security Advisories, privado).

Inclua os passos para reproduzir, o impacto estimado e a versão/commit e o
ambiente afetados. Tempo de primeira resposta: **3 dias úteis** (a confirmar
pelo responsável do projeto).

## Versões suportadas

Só a última versão publicada (tag `vX.Y.Z` mais recente) recebe correção.

## Por que segurança pesa neste projeto

O sistema tem **páginas públicas** (vitrine, acerto do cliente, acompanhamento do
consignador) e uma **área de administração** acima das lojas. Além disso,
guarda **dado pessoal de terceiros** (nome, telefone, CPF, e-mail e
endereço de compradores e consignadores), é **multi-tenant** (uma falha de
isolamento expõe a base de outra loja) e guarda a **credencial da sessão de
WhatsApp** de cada loja. Essas coisas definem a lista abaixo.

## O que a fundação já cobre

| Camada | Onde |
| --- | --- |
| SAST (injeção, SSRF, desserialização) | `codeql.yml` |
| Dependências vulneráveis | Dependabot (npm, Actions, Docker) e `npm audit` |
| Segredo commitado | Secret scanning + push protection (`SETUP-GITHUB.md` A4) |
| `.env` dentro da imagem | `.dockerignore` |
| Qualidade e hotspots de segurança | SonarCloud, dentro do `ci-success` |
| Credencial de deploy | Secrets por Environment, com aprovação em `homolog`/`prod` |
| Revisão humana | Checklist OWASP abaixo, cobrado no template de PR |

## Requisitos de segurança do pokemonAuction

Status: **feito** (já no código ou no banco), **Etapa N** (backlog do doc 02)
ou **infra** (depende da VPS). Item pendente é requisito, não sugestão: a
tarefa que o toca não está pronta sem ele.

### Isolamento entre lojas (multi-tenant)

| Requisito | Status |
| --- | --- |
| Toda tabela de negócio tem `store_id`; FK composta `(id, store_id)` impede lance, leilão, acerto ou carta apontar para outra loja | **feito** (migrations 0004 a 0007, com teste) |
| Middleware valida `x-store-id` contra `store_members` em toda rota autenticada, **negando por padrão** | Etapa 2 |
| Toda query de negócio filtra por `store_id`; teste de acesso cruzado entre lojas em cada rota nova (IDOR) | Etapa 2 em diante |
| **Row-Level Security** do Postgres como segunda barreira, com `FORCE`, contexto `app.store_id` por transação e papéis `owner`, `app_runtime` e `bot` ([ADR 0011](https://github.com/Project-PKA/shared/blob/main/docs/adr/0011-row-level-security-como-segunda-barreira.md)); teste de acesso cruzado rodando com papel **sem** `BYPASSRLS` | Etapa 2 (decidido) |

### Autenticação e sessão (ADR 0008)

| Requisito | Status |
| --- | --- |
| OTP e refresh token guardados só como **hash** (colunas `otp_hash`, `token_hash`) | **feito** (schema); hash HMAC com segredo próprio na Etapa 2 |
| OTP gerado com gerador criptográfico, 6 dígitos, **expira em minutos**, **limite de tentativas** (`otp_attempts`) e comparação em tempo constante | Etapa 2 |
| Resposta de login **idêntica** exista a conta ou não (sem enumeração de e-mail); e-mail sem conta **não recebe código e não cria usuário** (acesso só por convite, ADR 0012) | Etapa 2 |
| Usuário `SUSPENDED` não loga e tem as sessões revogadas na hora; `INVITED` só entra pelo convite | Etapa 2 |
| Rate limit por e-mail e por IP no pedido e na verificação do OTP | Etapa 2 |
| JWT de acesso curto (≤ 15 min), algoritmo fixo no servidor (nunca `none`), `exp`, `iss` e `aud` verificados | Etapa 2 |
| Refresh token rotacionado a cada uso; **reuso de token já trocado revoga a família inteira**; logout revoga | Etapa 2 |
| Cookie do refresh: `HttpOnly`, `Secure`, `SameSite` restrito | Etapa 2 |
| RBAC verificado **no servidor** em cada ação (`can_delete`, `can_view_finance`...); nunca confiar no que o frontend esconde | Etapa 2 |

### Dados pessoais e LGPD

| Requisito | Status |
| --- | --- |
| Nenhum telefone, e-mail, CPF, token, cookie, header `Authorization` ou texto de lance em log (redação de campos no logger) | Etapa 2 |
| `bids.raw_whatsapp_message` e dados de visitante tratados como pessoais: política de retenção e exclusão | pendente (decisão de negócio) |
| Base legal do tratamento, atendimento a direitos do titular (acesso, correção, exclusão) e papel de controlador/operador entre SaaS e loja | pendente (decisão de negócio) |
| Validação de CPF, telefone e CEP na entrada | Etapa 4 |
| Seed usa só dados fictícios e **recusa rodar** fora de `local`/`dev`/`test` | **feito** |

### Sessão do WhatsApp e bot (ADR 0007)

| Requisito | Status |
| --- | --- |
| `stores.whatsapp_session_data` guardado **criptografado** (AES-256-GCM, chave `WHATSAPP_SESSION_ENCRYPTION_KEY` fora do banco) | Etapa 5 (coluna já existe) |
| Role do banco do bot com **privilégio mínimo**: só as tabelas e colunas que o fluxo exige, sem DDL, sem `SUPERUSER` | Etapa 5 |
| Decisão de lance dentro de transação com lock da linha do leilão; valor, incremento e blacklist validados no servidor | Etapa 5 |
| O ID da carta e o texto da mensagem são tratados como entrada não confiável (regex estrita, tamanho máximo, sem eval/SQL concatenado) | Etapa 5 |
| Risco aceito: banimento do número e violação dos termos do WhatsApp (ADR 0007) | aceito |

### API e aplicação

| Requisito | Status |
| --- | --- |
| Entrada validada por schema; campo extra descartado | **feito** (Ajv `removeAdditional`) |
| Erro 5xx nunca devolve mensagem interna nem stack | **feito** (`src/http/problem.ts`, com teste) |
| SQL só parametrizado (Drizzle ou `pg` com `$1`); nunca concatenar entrada | **feito** até aqui; vale para todo código novo |
| Cabeçalhos de segurança (`@fastify/helmet`), CORS com **lista explícita de origens**, limite de corpo e timeouts, rate limit global | Etapa 2 (exige aprovar dependências) |
| `/metrics` **não** exposto na internet: só rede interna ou autenticado | infra |
| Upload de foto: tipo e tamanho validados, nome gerado pelo servidor, sem caminho vindo do usuário | Etapa 3 |
| Sync do TCGdex busca **só** a URL fixa do repositório oficial (sem SSRF) e valida o formato antes do `INSERT` | Etapa 3 |
| `npm audit` limpo | **feito** (0 vulnerabilidades) |

### Infraestrutura (VPS)

| Requisito | Status |
| --- | --- |
| HTTPS em tudo; Postgres e Redis **sem porta pública** (o `compose.yaml` publica a 5432 só para uso local) | infra |
| SSH por chave, sem senha, usuário de deploy sem root; firewall fechado exceto 80/443/SSH | infra |
| App conecta com usuário **sem** `SUPERUSER`; migrations com credencial separada, usada só no deploy | infra |
| Backup do banco automático, criptografado e com **restauração testada** | infra |
| Secrets só nos GitHub Environments, rotação documentada (`docs/secrets.md`) | **feito** (documento); valores a criar |

### Convites, administração e contas (ADR 0012)

| Requisito | Status |
| --- | --- |
| Token de convite aleatório de alta entropia, guardado só como hash, com **expiração**, uso único e revogação | Etapa 2 |
| `is_platform_admin` só por comando de linha, **nunca** por API ou tela; sem "primeiro usuário vira admin" | Etapa 2 |
| Fronteira do administrador no banco: lê `stores` e `store_members`, cria loja, e **não acessa** estoque, clientes, leilões, lances e acertos (teste de contrato com o papel real) | Etapa 2 |
| Toda ação do administrador e toda transferência de propriedade vai para o log de atividades, que o proprietário não consegue editar | Etapa 2 |
| Nunca deixar uma loja sem proprietário; remover o último `OWNER` é recusado | Etapa 2 |
| Criar loja só com `can_create_stores` e abaixo do `store_limit`, verificado no servidor e dentro de transação (sem corrida) | Etapa 2 |
| Formulário público "Solicitar acesso": limite por IP, campo-isca, validação e tamanho máximo; não cria usuário nem loja | Etapa 2 |
| Conta de administrador com proteção reforçada: sessão curta e avaliação de segundo fator | pendente |

### Páginas públicas (ADR 0014)

| Requisito | Status |
| --- | --- |
| Token do link com 128 bits ou mais, guardado só como hash, com expiração e revogação; resposta **igual** para inválido, expirado e revogado | Etapa 6 |
| Limite de tentativas e **bloqueio temporário** em qualquer segredo digitado (chave do consignador), por link e por IP, **desde o primeiro dia** | Etapa 6 |
| Chave de 4 dígitos do CPF só como **segundo fator** sobre o token; link por consignador e loja; sem CPF cadastrado, sem link | Etapa 6 |
| Acesso público por papel de banco próprio, executando só funções `SECURITY DEFINER` auditadas; nenhuma política de RLS afrouxada | Etapa 6 e 8 |
| Dado mínimo na resposta: telefone sempre parcial; nunca CPF, e-mail ou endereço de terceiros | Etapa 6 e 8 |
| `Referrer-Policy: no-referrer` e `noindex` nas páginas com token | Etapa 6 |
| Vitrine só com lojas que optaram; limite de leitura contra coleta em massa; o link do grupo de WhatsApp fica público e a loja é avisada | Etapa 8 |
| Consentimento LGPD registrado (quem, quando, versão do texto, IP); CPF validado no servidor | Etapa 6 |
| Upload do comprovante: tipo e tamanho validados, nome gerado pelo servidor, fora da raiz pública, entrega só a quem tem permissão na loja | Etapa 6 |
| "Já paguei" só notifica; **nunca** marca o acerto como pago (ADR 0013) | Etapa 6 |
| Texto de interface sem linguagem de garantia ("anti-calote", "compra segura") | Etapa 6 em diante |

### Decisões de segurança em aberto

1. **Criptografia de CPF e telefone em repouso** (além do disco da VPS):
   protege contra vazamento de backup, ao custo de não poder buscar por ele
   direto. Decidir com a revisão de LGPD.
2. **Segundo fator para o administrador da plataforma:** a conta mais
   valiosa do sistema. Avaliar antes de produção.
3. **Provedor de e-mail do OTP** (entregabilidade e, por ser porta de entrada,
   também segurança).

## Checklist OWASP Top 10

Use ao revisar qualquer mudança que toque autenticação, dados sensíveis ou
entrada externa (o template de PR já cobra):

1. **Broken Access Control:** autorização verificada em todo endpoint novo
   ou alterado; sem acesso a recurso de outra loja ou outro usuário por troca
   de ID (IDOR).
2. **Cryptographic Failures:** TLS em trânsito; dado sensível criptografado em
   repouso quando aplicável; OTP e refresh só em hash; nenhum segredo em log
   ou código.
3. **Injection:** toda entrada externa validada; SQL só parametrizado ou via
   ORM; nada de comando de sistema montado com entrada.
4. **Insecure Design:** limite de payload, rate limiting e timeouts desde o
   desenho; mensagem de erro não revela se a conta existe.
5. **Security Misconfiguration:** CORS restritivo, headers de segurança,
   sem debug/stack trace em produção, permissões padrão fechadas.
6. **Vulnerable and Outdated Components:** Dependabot limpo; dependência nova
   passa pela aprovação humana (`AGENTS.md`, seção 6).
7. **Identification and Authentication Failures:** sessão e tokens seguem o
   `ARCHITECTURE.md` (seção 6); expiração e revogação funcionam.
8. **Software and Data Integrity Failures:** imagem só a construída pelo CI
   (build once); migration aplicada não é editada (checksum).
9. **Security Logging and Monitoring Failures:** login, falha de autorização
   e mudança de permissão logados de forma estruturada, sem dado sensível.
10. **SSRF:** nenhuma requisição a URL/host vindo de entrada externa sem
    allowlist.

## Gestão de secrets

Ver `ARCHITECTURE.md`, seção 7, e [`docs/secrets.md`](docs/secrets.md).
