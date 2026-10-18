# syntax=docker/dockerfile:1
#
# Imagem da API (Node 22). Multi-stage:
#   deps    instala só as dependências de produção;
#   build   instala tudo e compila o TypeScript;
#   runtime leva o código compilado, as dependências de produção e as migrations.
#
# Regras (DEPLOY.md):
#   - a mesma imagem vai de dev a prod: a configuração chega em RUNTIME, por
#     variáveis do GitHub Environment, nunca gravada aqui;
#   - roda como usuário não root;
#   - o .dockerignore impede que .env, .git, testes e coverage entrem;
#   - a versão do Node é a de .tool-versions e está escrita por extenso nos três
#     FROM de propósito: o Dependabot só atualiza tag literal.

##############################
# Dependências de produção
##############################
FROM node:26.12.0-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund

##############################
# Build
##############################
FROM node:26.12.0-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

##############################
# Runtime
##############################
FROM node:26.12.0-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app

COPY --from=deps  --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# A API lê a versão do package.json em runtime (contrato OpenAPI).
COPY --chown=node:node package.json ./
# O deploy roda as migrations com ESTA imagem: `node dist/db/cli.js up`.
COPY --chown=node:node migrations ./migrations

# Usuário não root (a imagem oficial do Node já traz `node`, uid 1000).
USER node

EXPOSE 8080

# Liveness: GET /health (ARCHITECTURE.md). Sem curl na imagem: usa o fetch do Node.
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Rode com `--init` (o compose já faz) para o PID 1 repassar sinais e colher processos.
CMD ["node", "dist/server.js"]
