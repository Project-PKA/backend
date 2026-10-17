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
| `DATABASE_URL` | secret | Conexão do Backend com o Postgres | Montada com usuário e senha do Backend |
| `DB_PASSWORD` | secret | Senha do usuário do Backend | Gerador de senha, 32+ caracteres |
| `BOT_DB_PASSWORD` *(proposto)* | secret | Senha da role do `whatsapp_microservice` (criada na migration inicial) | Gerador de senha, 32+ caracteres |
| `JWT_ACCESS_SECRET` *(proposto)* | secret | Assina o access JWT | `openssl rand -base64 48` |
| `REFRESH_TOKEN_PEPPER` *(proposto)* | secret | Tempero do hash do refresh token | `openssl rand -base64 48` |
| `OTP_HASH_SECRET` *(proposto)* | secret | Chave do hash do código OTP | `openssl rand -base64 48` |
| `WHATSAPP_SESSION_ENCRYPTION_KEY` *(proposto)* | secret | Criptografa `stores.whatsapp_session_data`. **Mesma chave no Backend e no bot** | `openssl rand -base64 32` |
| `REDIS_URL` / `REDIS_PASSWORD` *(proposto)* | secret | Fila BullMQ | Senha gerada |
| `EMAIL_API_KEY` *(proposto)* | secret | Envio do OTP. **Provedor ainda não decidido** | Conta no provedor escolhido |
| `GRAFANA_ADMIN_PASSWORD` *(proposto)* | secret | Painel de observabilidade | Gerador de senha |
| `APP_BASE_URL` | variable | URL pública, usada no smoke test do deploy | Domínio, depois da VPS |

**Atenção ao `WHATSAPP_SESSION_ENCRYPTION_KEY`:** perder a chave significa
perder todas as sessões salvas (cada loja precisa ler o QR Code de novo).
Guarde uma cópia em gerenciador de senhas.

## 3. Deploy na VPS (depois da VPS existir)

Fluxo: imagem no GHCR, SSH, `docker compose`. O push no GHCR usa o
`GITHUB_TOKEN` do workflow, sem secret extra.

| Nome | Tipo | Para quê | Como obter |
| --- | --- | --- | --- |
| `SSH_HOST` *(proposto)* | variable | Endereço da VPS | Provedor |
| `SSH_USER` *(proposto)* | variable | Usuário de deploy (sem root) | Criado na VPS |
| `SSH_PRIVATE_KEY` *(proposto)* | secret | Chave do usuário de deploy | `ssh-keygen -t ed25519`; a pública vai para a VPS |
| `SSH_KNOWN_HOSTS` *(proposto)* | secret | Impressão digital do servidor, evita MITM | `ssh-keyscan <host>` |
| `GHCR_PULL_TOKEN` *(proposto)* | secret | A VPS puxar a imagem privada | PAT com `read:packages` |

## 4. Como criar no GitHub

1. Settings, Environments: crie `dev`, `homolog` (com aprovação obrigatória)
   e `prod` (com aprovação obrigatória). Passo a passo em
   [`SETUP-GITHUB.md`](../SETUP-GITHUB.md), B4.
2. Em cada Environment, Add secret para cada linha da seção 2.
3. `AUTOMATION_TOKEN`, `SONAR_TOKEN` e as variables da seção 1 ficam no nível
   da organização (ou do repositório, se não houver org).
4. Atualize a coluna "Como obter" aqui se descobrir um caminho melhor.
