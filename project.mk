# =============================================================================
# COMANDOS DO PROJETO
#
# Este e o unico arquivo que voce preenche para ligar a fundacao a sua stack.
# O `Makefile` (que voce nao edita) e o CI so conhecem os nomes abaixo.
#
# Tres estados possiveis para cada variavel:
#
#   vazio   -> nao configurado. O alvo FALHA com instrucao. E o estado inicial.
#   skip    -> nao se aplica a este projeto. O alvo passa, avisando.
#   comando -> executado como esta, no shell.
#
# Use `skip` de forma consciente: ele e uma decisao registrada
# ("linguagem compilada, sem typecheck separado"), nao um esquecimento.
# `make doctor` mostra os tres estados de uma vez.
#
# O `BOOTSTRAP.md` conduz o preenchimento deste arquivo com um agente de IA.
# Os exemplos comentados no fim servem de ponto de partida.
# =============================================================================

# -----------------------------------------------------------------------------
# Ciclo de desenvolvimento
# -----------------------------------------------------------------------------

# Instala dependencias de forma reprodutivel (lockfile obrigatorio no CI).
SETUP_CMD = npm ci --no-audit --no-fund

# Sobe a API localmente. O banco sobe antes com: docker compose up -d db
RUN_CMD = npm run dev

# Compila/empacota. Linguagem interpretada sem build? Use um comando que
# valide o pacote (ex.: `python -m compileall -q app`) ou `skip`.
BUILD_CMD = npm run build

# Remove artefatos e relatorios.
CLEAN_CMD = rm -rf $(BUILD_DIR) coverage

# Onde o build deposita o artefato.
BUILD_DIR = dist

# -----------------------------------------------------------------------------
# Qualidade
#
# O lint DEVE cobrir code smells/complexidade, alem dos erros basicos
# (ex.: eslint-plugin-sonarjs, regras C90/PL do ruff, gocognit no golangci).
# -----------------------------------------------------------------------------

LINT_CMD = npx eslint . --max-warnings=0
LINT_FIX_CMD = npx eslint . --fix
FORMAT_CMD = npx prettier --write "src/**/*.ts" "test/**/*.ts" "scripts/**/*.ts" "*.{ts,js,json}"
FORMAT_CHECK_CMD = npx prettier --check "src/**/*.ts" "test/**/*.ts" "scripts/**/*.ts" "*.{ts,js,json}"

# `skip` em linguagem compilada (o build ja checa tipos).
TYPECHECK_CMD = npx tsc --noEmit

# -----------------------------------------------------------------------------
# Testes
# -----------------------------------------------------------------------------

TEST_CMD = npx vitest run
TEST_WATCH_CMD = npx vitest

# Grava o relatorio em coverage/. `coverage/lcov.info` e o formato que o
# comentario de cobertura no PR entende; se a ferramenta so gerar o formato
# nativo, aponte-o em sonar-project.properties.
TEST_COVERAGE_CMD = npx vitest run --coverage

# -----------------------------------------------------------------------------
# Banco de dados (docs/database.md)
#
# O ORM precisa entregar: migrations numeradas e reversiveis + tipos gerados
# a partir do schema.
# -----------------------------------------------------------------------------


# Aplica as migrations pendentes.
MIGRATE_CMD = npm run db:migrate

# Cria uma migration nova. Recebe o nome em $(NAME):  make migration NAME=cria-pedidos
MIGRATION_CMD = npm run db:new -- $(NAME)

# Popula o banco com os dados de desenvolvimento (todos os estados relevantes).
# PENDENTE de proposito: ainda nao ha tabelas. Entra na Etapa 1 do backlog,
# junto com o schema (um `skip` aqui seria falsa seguranca).
SEED_CMD =

# -----------------------------------------------------------------------------
# Contrato de API
#
# Gera docs/api/openapi.yaml A PARTIR DO CODIGO. O CI roda este alvo e falha
# se o arquivo gerado diferir do commitado. `skip` se o servico nao expoe API.
# -----------------------------------------------------------------------------

OPENAPI_CMD = npm run openapi:generate
