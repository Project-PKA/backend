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
| Middleware valida `x-store-id` contra `store_members` em toda rota autenticada, **negando por padrão** (header ausente, malformado ou de loja alheia dão a mesma resposta 403) | **feito** (`requireStore`, com teste) |
| Toda query de negócio filtra por `store_id`; teste de acesso cruzado entre lojas em cada rota nova (IDOR) | Etapa 2 em diante |
| **Row-Level Security** do Postgres como segunda barreira, com `FORCE`, contexto por transação (`withContext`) e papéis `owner` e `app_runtime` ([ADR 0011](https://github.com/Project-PKA/shared/blob/main/docs/adr/0011-row-level-security-como-segunda-barreira.md)); teste de acesso cruzado com o papel real, **sem** `BYPASSRLS` | **feito** (migration 0009 e `test/rls.integration.test.ts`); o papel `bot` entra na Etapa 5 |

### Autenticação e sessão (ADR 0008)

| Requisito | Status |
| --- | --- |
| OTP e refresh token guardados só como **hash** HMAC com segredo próprio, amarrado ao e-mail (OTP) e a um domínio (`refresh`, `invitation`) | **feito** (`src/auth/crypto.ts`, com teste) |
| OTP gerado com `crypto.randomInt`, 6 dígitos, **expira em 10 min**, **5 tentativas** e comparação em tempo constante (custo igual com ou sem conta) | **feito** |
| Resposta de login **idêntica** exista a conta ou não (sem enumeração de e-mail); e-mail sem conta **não recebe código e não cria usuário** (acesso só por convite, ADR 0012). O envio do e-mail não é aguardado, para o tempo de resposta não revelar a conta | **feito** (limite residual: pequena diferença de tempo no acesso ao banco, contida pelo rate limit) |
| Usuário `SUSPENDED` não loga e perde o acesso na hora (o estado é conferido a cada requisição); `INVITED` só entra pelo convite | **feito**; a rota que suspende e revoga as sessões vem na Etapa 2c (`revokeAllSessions` já existe) |
| Rate limit por IP no pedido e na verificação do OTP, mais intervalo mínimo por e-mail e contagem de tentativas | **feito** (429 em `problem+json`); depende de `TRUST_PROXY=true` atrás do proxy |
| JWT de acesso curto (15 min), algoritmo fixo no servidor (HS256, nunca `none`), `exp`, `iss` e `aud` verificados | **feito** (teste com `alg: none`, assinatura alheia e token vencido) |
| Refresh token rotacionado a cada uso; **reuso de token já trocado revoga todas as sessões da pessoa**; logout revoga | **feito** (duas abas renovando ao mesmo tempo podem disparar a revogação: o usuário só precisa entrar de novo) |
| Cookie do refresh: `HttpOnly`, `Secure` (fora de desenvolvimento), `SameSite=Strict`, restrito a `/v1/auth` | **feito** |
| RBAC verificado **no servidor** em cada ação (`requirePermission`, `requireOwner`); nunca confiar no que o frontend esconde | **feito** (hooks); cada rota nova precisa aplicá-los |

### Dados pessoais e LGPD

| Requisito | Status |
| --- | --- |
| Nenhum telefone, e-mail, CPF, token, cookie, header `Authorization` ou texto de lance em log | **parcial**: `Authorization`, `Cookie` e `Set-Cookie` são redigidos e um teste manual confirmou que o token não aparece. O provedor `log` de e-mail imprime o código (só em desenvolvimento; recusado em homolog e prod). Falta revisar os logs de cada rota nova |
| `bids.raw_whatsapp_message` e dados de visitante tratados como pessoais: exclusão sob pedido | **feito** (anonimização, `POST /v1/customers/{id}/anonymize`, migration 0026: apaga nome, telefone, e-mail, CPF, endereço, a mensagem original dos lances, o IP do consentimento e o comprovante; mantém o id e os valores; revoga os links públicos; com teste que procura o dado em todas as tabelas). **Retenção por prazo** segue pendente (decisão de negócio, só com loja real) |
| Base legal do tratamento, atendimento a direitos do titular (acesso, correção, exclusão) e papel de controlador/operador entre SaaS e loja | pendente (decisão de negócio) |
| Validação de CPF (dígitos verificadores), telefone e CEP na entrada; guardados só com dígitos | **feito** (com teste) |
| CPF nunca devolvido inteiro (só `•••.•••.•••-NN`), nunca em log; o log de atividades guarda só os nomes dos campos alterados | **feito** (com teste) |
| CPF, telefone, nascimento e endereço do **usuário** (perfil, `PATCH /v1/me`; o dono decidiu guardar): CPF cifrado com o mesmo `CpfVault` do cliente (ADR 0019), só a máscara na saída; só a própria pessoa lê e edita; não aparece no painel do administrador nem na equipe; nunca em log | **feito** (migration 0027, com teste). A rotação da chave do CPF precisa cobrir também `users.cpf` (ver Backend#118) |
| Pareamento do WhatsApp pelo painel (`whatsapp_pairing`, migration 0028): o QR liga a conta de quem o escaneia ao bot, então só o **proprietário** da loja do contexto o lê (política `owner_only` no banco, mais a rota), com 60 s de vida, `Cache-Control: no-store`, fora do alcance do administrador da plataforma e apagado pela limpeza diária se o bot cair. O bot só vê quem pediu e não lê o QR de volta | **feito** (com teste). Falta incluir o QR no teste de log quando o PR do log (#119) entrar |
| Seed usa só dados fictícios e **recusa rodar** fora de `local`/`dev`/`test` | **feito** |

### Sessão do WhatsApp e bot (ADR 0007)

| Requisito | Status |
| --- | --- |
| Sessão do WhatsApp fora do alcance do administrador e nunca em log. Com o neonize a sessão é persistida pela biblioteca (SQLite ou PostgreSQL): o formato de armazenamento e a criptografia serão decididos no bootstrap do bot ([ADR 0015](https://github.com/Project-PKA/shared/blob/main/docs/adr/0015-bot-em-python-com-neonize.md)). Regra mantida: `whatsapp_sessions.session_data` (tabela própria, só visível com o contexto da própria loja, nem o administrador a lê) guardado **criptografado** (AES-256-GCM, chave `WHATSAPP_SESSION_ENCRYPTION_KEY` fora do banco) | tabela e isolamento **feitos**; a criptografia entra na Etapa 5 |
| Role do banco do bot com **privilégio mínimo**: só as tabelas e colunas que o fluxo exige, sem DDL, sem `SUPERUSER` | Etapa 5 |
| Decisão de lance dentro de **uma função do banco** (`place_bid`) com trava da linha do leilão; valor, incremento e blacklist validados lá, para API e bot usarem a mesma regra ([ADR 0016](https://github.com/Project-PKA/shared/blob/main/docs/adr/0016-decisao-de-lance-em-funcao-do-banco.md)) | **feito** (migration 0013; função `SECURITY INVOKER`, sob o RLS; testes com lances simultâneos e com loja errada) |
| Marcar acerto como pago é só da loja e exige `can_view_finance`; o comprador nunca altera estado de pagamento. Acertos criados com lock nas linhas dos leilões (dois acertos simultâneos não repetem um leilão) | **feito** (com teste) |
| Páginas públicas por link ([ADR 0014](https://github.com/Project-PKA/shared/blob/main/docs/adr/0014-paginas-publicas-por-link-e-vitrine.md), D13 aprovada): token de 256 bits só em hash, expiração e revogação, resposta idêntica para link inválido/expirado/revogado/bloqueado/chave errada, 5 chaves erradas bloqueiam o link por 15 min, 20 falhas por IP bloqueiam o IP por 15 min, limite de requisições, `Referrer-Policy: no-referrer`, `noindex` e `no-store`, papel `public_runtime` sem acesso a tabela (só `EXECUTE` em funções `SECURITY DEFINER` com `search_path` fixo) | **feito** (migration 0015, com testes de abuso) |
| "Já paguei" do comprador só grava um aviso e notifica a loja; nunca muda o estado do acerto (só a loja marca como pago, com `can_view_finance`) | **feito** (com teste) |
| Consentimento LGPD do acerto registrado (quem, quando, versão do texto, IP); CPF validado no servidor e nunca devolvido inteiro | **feito** |
| Financeiro (`/v1/finance/*`) exige `can_view_finance` em todas as rotas e só lê a loja do contexto (RLS); período fechado em valores permitidos | **feito** (com teste) |
| Área `/v1/admin`: `requirePlatformAdmin` em toda rota; o administrador não lê dado interno de loja (RLS, com teste); suspender derruba as sessões; não suspende a si mesmo nem a outro administrador; transferir propriedade trava os proprietários (nunca zero, nem sob concorrência); log próprio da plataforma, só do administrador | **feito** (com teste) |
| Pedido de acesso público: sem login, só por função `SECURITY DEFINER` (`public_access_request_submit`); resposta igual para novo, repetido ou descartado; campo-isca; limite por minuto e 10 pedidos por IP/dia; e-mail só depois da decisão do administrador; IP em hash | **feito** (com teste) |
| Vitrine pública (ADR 0014): só lojas que optaram (liga com o link do grupo e a confirmação de que ele ficará público), WhatsApp conectado, função `SECURITY DEFINER` sem telefone nem nome de cliente, página de no máximo 48 e deslocamento de no máximo 480, limite por minuto e cache curto contra coleta em massa | **feito** (com teste) |
| Notificações: só código e ids, por loja (RLS), leitura por pessoa | **feito** |
| Limpeza de dados vencidos por `purge_expired()` (`SECURITY DEFINER`, só `app_runtime`): sessões, OTP, falhas por IP, links e convites antigos; dado pessoal fica de fora até a decisão de retenção (D2) | **feito** (com teste) |
| Deploy: a API não recebe a senha do dono do schema nem a do backup; sistema de arquivos somente leitura, sem capacidades Linux; só o Caddy publica porta; `/metrics` não sai pela internet; backup criptografado (AES-256) com restauração testada | **feito** (testado localmente; falta a VPS) |
| Sala de lances devolve telefone com o miolo oculto e nunca o texto original da mensagem | **feito** (com teste) |
| O ID da carta e o texto da mensagem são tratados como entrada não confiável (regex estrita, tamanho máximo, sem eval/SQL concatenado) | Etapa 5 |
| Risco aceito: banimento do número e violação dos termos do WhatsApp (ADR 0007) | aceito |

### API e aplicação

| Requisito | Status |
| --- | --- |
| Entrada validada por schema; campo extra descartado | **feito** (Ajv `removeAdditional`) |
| Erro 5xx nunca devolve mensagem interna nem stack | **feito** (`src/http/problem.ts`, com teste) |
| SQL só parametrizado (Drizzle ou `pg` com `$1`); nunca concatenar entrada | **feito** até aqui; vale para todo código novo |
| Cabeçalhos de segurança (`@fastify/helmet`), CORS com **lista explícita de origens** (nunca `*`) e rate limit global | **feito** (com teste) |
| Limite de corpo (256 KB) e timeouts de requisição (30 s) e de handler (20 s) explícitos e configuráveis; corpo grande dá 413 em `problem+json` | **feito** |
| `/metrics` **não** exposto na internet: só rede interna ou autenticado | infra |
| Upload de foto: tipo e tamanho validados, nome gerado pelo servidor, sem caminho vindo do usuário | pendente (decisão D3 de armazenamento) |
| Sync do TCGdex busca **só** a URL fixa do repositório oficial (sem SSRF) e valida o formato antes do `INSERT` | **feito** (`src/catalog/tcgdex.ts`: só GET, host fixo, sem redirecionamento, limite de tamanho, id e idioma validados; resposta parcial é recusada; com teste) |
| Busca do catálogo: curinga do `LIKE` (`%`, `_`) nunca vem da entrada; mínimo de 2 caracteres e no máximo 6 termos | **feito** (com teste) |
| Estoque: toda rota filtra por `store_id` e passa pelo RLS; carta de outra loja responde 404 igual a inexistente; edição e exclusão só fora de leilão; origem sem valor padrão | **feito** (com teste de acesso cruzado) |
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
| Reenvio de convite com intervalo mínimo (anti-spam) e token novo; revogar derruba o link na hora; convite de outra loja responde 404 | **feito** |
| Token de convite aleatório de alta entropia (256 bits), guardado só como hash, com **expiração**, uso único e revogação; vai no fragmento do link (`#token=`), que não chega ao log do servidor nem ao `Referer` | **feito** |
| `is_platform_admin` só por comando de linha (`npm run db:create-admin`), **nunca** por API ou tela; sem "primeiro usuário vira admin" | **feito** |
| Fronteira do administrador no banco: lê `stores` e `store_members`, cria loja, e **não acessa** estoque, clientes, leilões, lances, acertos nem a sessão do WhatsApp (teste com o papel real) | **feito** |
| Ações sensíveis de uma loja vão para o log de atividades, **imutável** para a aplicação (só `INSERT` e `SELECT`) e **legível só pelo proprietário** (o banco confere o papel na política), gravado na mesma transação da ação, sem e-mail nem dado pessoal | **feito** (`activity_log`, com teste). O log das ações do administrador da plataforma fica na Etapa 2c |
| Nunca deixar uma loja sem proprietário; remover o último `OWNER` é recusado, inclusive com dois proprietários se removendo ao mesmo tempo | **feito** para remoção de membro (lock dos proprietários, com teste de corrida). A transferência de propriedade vem na 2c |
| Criar loja só com `can_create_stores` e abaixo do `store_limit`, verificado no servidor e dentro de transação (a linha do usuário fica travada: criações simultâneas no limite não passam) | **feito** (teste com 4 criações simultâneas). O limite conta lojas em que a pessoa é **proprietária** |
| Formulário público "Solicitar acesso": limite por IP, campo-isca, validação e tamanho máximo; não cria usuário nem loja | Etapa 2c |
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

1. **Criptografia do CPF em repouso: feita** (migration 0024, ADR 0019 do shared): AES-256-GCM com
   `CPF_ENCRYPTION_KEY` (guarde a chave à parte; sem ela o CPF não volta). O telefone continua
   em texto, porque identifica o cliente no grupo. A exclusão sob pedido está feita
   (anonimização, migration 0026). Falta decidir com a revisão de LGPD: retenção por prazo e
   rotação da chave.
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
