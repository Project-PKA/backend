# Secrets e variáveis do Backend

> Só **nomes** e onde configurar. Nenhum valor entra neste arquivo. Os valores
> ficam no GitHub (Secrets/Variables) e, para guardar localmente enquanto você
> os junta, em `.env.secrets.local` (ignorado pelo git).
>
> Decisão: secrets do GitHub Environment, injetados no deploy
> ([`ARCHITECTURE.md`](../ARCHITECTURE.md), seção 7). **Quem cria os secrets é
> você**; o agente só lista o que é preciso.
>
> Nomes marcados *(proposto)* ainda não existem no código; viram definitivos
> quando a variável for criada, junto com `.env.example` e a leitura validada
> de ambiente.

## 1. CI e automação (agora)

| Nome | Tipo | Escopo | Para quê | Como obter |
| --- | --- | --- | --- | --- |
| `AUTOMATION_TOKEN` | secret | org ou repo | Project, release-please e PR de contrato no `shared` | PAT fine-grained ou GitHub App com acesso a `Backend` e `shared` (contents, pull requests, projects) |
| `SONAR_TOKEN` | secret | org ou repo | Quality Gate no CI | SonarCloud, My Account, Security |
| `PROJECT_URL` | variable | org | GitHub Project | URL do Project |
| `CONTRACT_REPO` | variable | org | Repo do docs/shared | valor: `Project-PKA/shared` |
| `CODEQL_LANGUAGES` | variable | repo | Linguagem do CodeQL | valor: `javascript-typescript` |

## 2. Aplicação, por Environment (`dev`, `homolog`, `prod`)

Um valor diferente em cada Environment. Nunca reutilize o de `prod` fora dele.

| Nome | Tipo | Para quê | Como gerar |
| --- | --- | --- | --- |
| `DATABASE_URL` | secret | Conexão da **API em execução** com o Postgres, pelo papel `app_api` (grupo `app_runtime`, **sem** `BYPASSRLS`). É este papel que sofre o RLS | Montada com a senha do `app_api` |
| `DB_BOT_PASSWORD` | secret | Senha do login do bot de WhatsApp (`bot_api`, grupo `bot_runtime`, sem BYPASSRLS). Opcional: sem ela a provisão não cria o login do bot | Gerador de senha, 24+ caracteres (`openssl rand -hex 32`) |
| `DB_APP_PASSWORD` | secret | Senha do papel de login `app_api`, criado na provisão do ambiente (`CREATE ROLE app_api LOGIN ... IN ROLE app_runtime`) | Gerador de senha, 32+ caracteres |
| `MIGRATION_DATABASE_URL` | secret | Conexão do **dono do schema** (com `BYPASSRLS`): só migrations, seed de desenvolvimento e `db:create-admin`, durante o deploy. A API em execução nunca a recebe | Montada com a senha do dono |
| `DB_PASSWORD` | secret | Senha do dono do schema | Gerador de senha, 32+ caracteres |
| `BOT_DB_PASSWORD` *(proposto)* | secret | Senha da role do `whatsapp_microservice` (criada na migration inicial) | Gerador de senha, 32+ caracteres |
| `JWT_ACCESS_SECRET` | secret | Assina o access JWT | `openssl rand -base64 48` |
| `REFRESH_TOKEN_PEPPER` | secret | Tempero do hash do refresh token | `openssl rand -base64 48` |
| `OTP_HASH_SECRET` | secret | Chave do hash do código OTP | `openssl rand -base64 48` |
| `WHATSAPP_SESSION_ENCRYPTION_KEY` *(proposto)* | secret | Criptografa `whatsapp_sessions.session_data`. **Mesma chave no Backend e no bot** | `openssl rand -base64 32` |
| `REDIS_URL` | secret | Redis do BullMQ (`redis://:senha@host:6379`). **Obrigatória em homolog e prod**: sem ela a API recusa subir. Redis sem porta pública | Senha gerada (`openssl rand -base64 32`) |
| `RATE_LIMIT_PUBLIC_PER_MINUTE` | variable | Requisições por minuto e por IP nas rotas públicas por link (padrão 20) | Opcional |
| `RATE_LIMIT_SHOWCASE_PER_MINUTE` | variable | Leituras da vitrine pública por minuto e por IP (padrão 30) | Opcional |
| `RATE_LIMIT_ACCESS_REQUEST_PER_MINUTE` | variable | Pedidos de acesso da landing por minuto e por IP (padrão 3) | Opcional |
| `CATALOG_LANGUAGES` | variable | Idiomas do sync do catálogo (padrão `en,pt`; o primeiro é o canônico) | Opcional |
| `EMAIL_PASSWORD` | secret | **Senha de app** do Google (Conta > Segurança > Verificação em duas etapas > Senhas de app), usada no SMTP do Gmail. Nunca a senha da conta. Na VPS vai para o `.env` | Conta Google do dono |
| `SMTP_USER` | variable | Endereço Gmail que envia (também é o remetente padrão). Obrigatória com `EMAIL_PROVIDER=smtp` em homolog e prod | Conta Google do dono |
| `GRAFANA_ADMIN_PASSWORD` *(proposto)* | secret | Painel de observabilidade | Gerador de senha |
| `APP_BASE_URL` | variable | URL pública, usada no smoke test do deploy | Domínio, depois da VPS |
| `APP_PUBLIC_URL` | variable | URL pública do frontend, usada nos links de convite | Domínio do frontend |
| `CORS_ORIGINS` | variable | Origens do frontend autorizadas a chamar a API, separadas por vírgula. Nunca `*` | Domínio do frontend |
| `TRUST_PROXY` | variable | `true` atrás do reverse proxy, para o limite de requisições ver o IP real | `true` em homolog e prod |
| `EMAIL_PROVIDER` | variable | `smtp` (homolog e prod) ou `log` (só desenvolvimento: a API recusa subir com `log` em homolog e prod) | `smtp` |
| `SMTP_HOST` / `SMTP_PORT` | variable | Padrão `smtp.gmail.com` / `465` (TLS direto). No Mailpit local: `localhost` / `1025`, sem login | Opcional |
| `EMAIL_FROM` | variable | Remetente exibido. Padrão: `SMTP_USER` (o Gmail reescreve para a conta) | Opcional |
| `STORAGE_DIR` | variable | Pasta das fotos enviadas. No compose é o volume `storage_data` em `/app/storage` | Opcional |

**Atenção ao `WHATSAPP_SESSION_ENCRYPTION_KEY`:** perder a chave significa
perder todas as sessões salvas (cada loja precisa ler o QR Code de novo).
Guarde uma cópia em gerenciador de senhas.

### Papéis do banco (provisão manual, uma vez por ambiente)

As migrations criam o grupo `app_runtime` (sem login). O papel que conecta é criado fora delas, porque senha não entra em migration:

```sql
CREATE ROLE app_api LOGIN PASSWORD '<DB_APP_PASSWORD>' NOSUPERUSER NOBYPASSRLS IN ROLE app_runtime;
```

O dono do schema precisa de `BYPASSRLS` (ou ser superusuário), porque as tabelas usam `FORCE ROW LEVEL SECURITY`. Em desenvolvimento, `npm run db:provision-dev` faz a parte do `app_api`.

## 3. Deploy na VPS (depois da VPS existir)

Fluxo: imagem no GHCR, SSH, `docker compose`. O push no GHCR usa o
`GITHUB_TOKEN` do workflow, sem secret extra.

| Nome | Tipo | Para quê | Como obter |
| --- | --- | --- | --- |
| `SSH_HOST` | variable | Endereço da VPS | Provedor |
| `SSH_USER` | variable | Usuário de deploy (sem root) | Criado na VPS |
| `SSH_PRIVATE_KEY` | secret | Chave do usuário de deploy | `ssh-keygen -t ed25519`; a pública vai para a VPS |
| `SSH_KNOWN_HOSTS` | secret | Impressão digital do servidor, evita MITM | `ssh-keyscan <host>` |
| `GHCR_PULL_USER` | variable | Usuário do GitHub dono do `GHCR_PULL_TOKEN` | Seu usuário |
| `GHCR_PULL_TOKEN` | secret | A VPS puxar a imagem privada | PAT com `read:packages` |
| `DEPLOY_DIR` | variable (opcional) | Pasta do ambiente na VPS (padrão `/srv/pokemon-auction/<ambiente>`) | Criada na VPS |
| `DEPLOY_ENABLED` | variable (repositório) | Liga o job de deploy (`true`). Sem ela a imagem é só publicada | Criar quando a VPS e o `.env` estiverem prontos |

**No `.env` da VPS** (modelo `deploy/env.example`; nunca passa pelo GitHub nem pelo repositório):
`APP_DOMAIN`, `DB_OWNER_USER`, `DB_OWNER_PASSWORD`, `DB_APP_PASSWORD`, `REDIS_PASSWORD` (estes três com `openssl rand -hex 32`: base64 quebra a URL de conexão), `JWT_ACCESS_SECRET`, `REFRESH_TOKEN_PEPPER`, `OTP_HASH_SECRET`, `BACKUP_PASSPHRASE` e `BACKUP_KEEP_DAYS`.

## 4. Como criar no GitHub

1. Settings, Environments: crie `dev`, `homolog` (com aprovação obrigatória)
   e `prod` (com aprovação obrigatória). Passo a passo em
   [`SETUP-GITHUB.md`](../SETUP-GITHUB.md), B4.
2. Em cada Environment, Add secret para cada linha da seção 2.
3. `AUTOMATION_TOKEN`, `SONAR_TOKEN` e as variables da seção 1 ficam no nível
   da organização (ou do repositório, se não houver org).
4. Atualize a coluna "Como obter" aqui se descobrir um caminho melhor.
