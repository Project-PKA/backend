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
SETUP_CMD =

# Sobe a API localmente. O banco sobe antes com: docker compose up -d db
RUN_CMD =

# Compila/empacota. Linguagem interpretada sem build? Use um comando que
# valide o pacote (ex.: `python -m compileall -q app`) ou `skip`.
BUILD_CMD =

# Remove artefatos e relatorios.
CLEAN_CMD =

# Onde o build deposita o artefato.
BUILD_DIR = dist

# -----------------------------------------------------------------------------
# Qualidade
#
# O lint DEVE cobrir code smells/complexidade, alem dos erros basicos
# (ex.: eslint-plugin-sonarjs, regras C90/PL do ruff, gocognit no golangci).
# -----------------------------------------------------------------------------

LINT_CMD =
LINT_FIX_CMD =
FORMAT_CMD =
FORMAT_CHECK_CMD =

# `skip` em linguagem compilada (o build ja checa tipos).
TYPECHECK_CMD =

# -----------------------------------------------------------------------------
# Testes
# -----------------------------------------------------------------------------

TEST_CMD =
TEST_WATCH_CMD =

# Grava o relatorio em coverage/. `coverage/lcov.info` e o formato que o
# comentario de cobertura no PR entende; se a ferramenta so gerar o formato
# nativo, aponte-o em sonar-project.properties.
TEST_COVERAGE_CMD =

# -----------------------------------------------------------------------------
# Banco de dados (docs/database.md)
#
# O ORM precisa entregar: migrations numeradas e reversiveis + tipos gerados
# a partir do schema.
# -----------------------------------------------------------------------------

# Aplica as migrations pendentes.
MIGRATE_CMD =

# Cria uma migration nova. Recebe o nome em $(NAME):  make migration NAME=cria-pedidos
MIGRATION_CMD =

# Popula o banco com os dados de desenvolvimento (todos os estados relevantes).
SEED_CMD =

# -----------------------------------------------------------------------------
# Contrato de API
#
# Gera docs/api/openapi.yaml A PARTIR DO CODIGO. O CI roda este alvo e falha
# se o arquivo gerado diferir do commitado. `skip` se o servico nao expoe API.
# -----------------------------------------------------------------------------

OPENAPI_CMD =

# =============================================================================
# EXEMPLOS — copie, ajuste e descomente o bloco da sua stack.
# Servem como ponto de partida, nao como recomendacao.
# =============================================================================

# ---- Node + TypeScript + Fastify + Prisma + Vitest -------------------------
# SETUP_CMD          = npm ci --no-audit --no-fund
# RUN_CMD            = npm run dev
# BUILD_CMD          = npm run build
# CLEAN_CMD          = rm -rf $(BUILD_DIR) coverage
# LINT_CMD           = npx eslint . --max-warnings=0
# LINT_FIX_CMD       = npx eslint . --fix
# FORMAT_CMD         = npx prettier --write .
# FORMAT_CHECK_CMD   = npx prettier --check .
# TYPECHECK_CMD      = npx tsc --noEmit
# TEST_CMD           = npx vitest run
# TEST_WATCH_CMD     = npx vitest
# TEST_COVERAGE_CMD  = npx vitest run --coverage --coverage.reporter=lcov --coverage.reporter=json-summary
# MIGRATE_CMD        = npx prisma migrate deploy
# MIGRATION_CMD      = npx prisma migrate dev --name $(NAME)
# SEED_CMD           = npx prisma db seed
# OPENAPI_CMD        = npm run openapi:generate -- --output docs/api/openapi.yaml

# ---- Python + FastAPI + SQLAlchemy/Alembic + pytest (uv) -------------------
# SETUP_CMD          = uv sync --frozen
# RUN_CMD            = uv run uvicorn app.main:app --reload
# BUILD_CMD          = uv build
# LINT_CMD           = uv run ruff check .
# LINT_FIX_CMD       = uv run ruff check --fix .
# FORMAT_CMD         = uv run ruff format .
# FORMAT_CHECK_CMD   = uv run ruff format --check .
# TYPECHECK_CMD      = uv run mypy app
# TEST_CMD           = uv run pytest
# TEST_WATCH_CMD     = skip
# TEST_COVERAGE_CMD  = uv run pytest --cov=app --cov-report=lcov:coverage/lcov.info --cov-report=xml:coverage/coverage.xml
# MIGRATE_CMD        = uv run alembic upgrade head
# MIGRATION_CMD      = uv run alembic revision --autogenerate -m "$(NAME)"
# SEED_CMD           = uv run python -m app.seed
# OPENAPI_CMD        = uv run python -m app.openapi > docs/api/openapi.yaml

# ---- Go + sqlc + golang-migrate --------------------------------------------
# SETUP_CMD          = go mod download
# RUN_CMD            = go run ./cmd/api
# BUILD_CMD          = go build -o $(BUILD_DIR)/api ./cmd/api
# LINT_CMD           = golangci-lint run
# FORMAT_CHECK_CMD   = test -z "$$(gofmt -l .)"
# TYPECHECK_CMD      = skip
# TEST_COVERAGE_CMD  = mkdir -p coverage && go test ./... -coverprofile=coverage/coverage.out
# MIGRATE_CMD        = migrate -path migrations -database "$$DATABASE_URL" up
# MIGRATION_CMD      = migrate create -ext sql -dir migrations -seq $(NAME)
# OPENAPI_CMD        = swag init -g cmd/api/main.go -o docs/api --outputTypes yaml && mv docs/api/swagger.yaml docs/api/openapi.yaml
