# =============================================================================
# CONTRATO DE COMANDOS
#
# Este arquivo e a fronteira entre a fundacao (CI, hooks, documentacao) e a
# stack do projeto. A fundacao so conhece os alvos abaixo; ela nunca sabe se
# por tras deles ha Node, Python, Go, Java ou .NET.
#
# Consequencia pratica: trocar de ferramenta, de ORM ou ate de linguagem nao
# exige tocar em um unico workflow.
#
# VOCE NAO EDITA ESTE ARQUIVO. Os comandos reais vao em `project.mk`.
#
#   make help      lista os alvos
#   make doctor    mostra o que ja esta configurado e o que falta
#
# Alvos que o CI chama (ci.yml) precisam estar configurados — com um
# comando ou com `skip` consciente. Vazio, o CI falha, e `make doctor`
# tambem: os dois usam a mesma lista (REQUIRED_VARS).
#
# Windows: `make` nao vem instalado. Use WSL, ou instale com
#   winget install ezwinports.make      (ou: choco install make)
# =============================================================================

SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

# Comandos reais do projeto. Sem este arquivo, nada roda.
-include project.mk

# Diretorio do artefato de build. Sobrescreva em project.mk se necessario.
BUILD_DIR ?= dist

# -----------------------------------------------------------------------------
# run: executa o comando de um alvo. Recebe o NOME da variavel, nao o valor —
# assim um comando que contenha virgula nao quebra o $(call).
#
#   vazio  -> falha com instrucao de como configurar
#   skip   -> nao se aplica a este projeto; segue em frente
#   outro  -> executa (o make ecoa o comando)
# -----------------------------------------------------------------------------
define run
@$(if $(strip $($(1))),:,{ \
	printf '\n\033[31mFALTA CONFIGURAR: %s\033[0m\n\n' '$(1)'; \
	printf '  Defina %s em project.mk\n' '$(1)'; \
	printf '  Nao se aplica a este projeto? use:  %s = skip\n\n' '$(1)'; \
	printf '  %s\n\n' '$(2)'; \
	exit 1; \
})
	$(if $(filter skip,$(strip $($(1)))),@printf '\033[33m[skip]\033[0m %s nao se aplica a este projeto.\n' '$(1)',$($(1)))
endef

# =============================================================================
# Ciclo de desenvolvimento
# =============================================================================

.PHONY: setup
setup: hooks ## Instala dependencias e ativa os hooks de git
	$(call run,SETUP_CMD,ex.: npm ci / uv sync / go mod download / ./gradlew dependencies / dotnet restore)

.PHONY: run
run: ## Sobe a API localmente (o banco sobe com: docker compose up -d db)
	$(call run,RUN_CMD,ex.: npm run dev / uvicorn app.main:app --reload / go run ./cmd/api)

.PHONY: build
build: ## Compila/empacota a aplicacao
	$(call run,BUILD_CMD,ex.: npm run build / go build -o $(BUILD_DIR)/api ./cmd/api / ./gradlew build -x test)

.PHONY: clean
clean: ## Remove artefatos de build e relatorios
	$(call run,CLEAN_CMD,ex.: rm -rf $(BUILD_DIR) coverage)

# =============================================================================
# Qualidade
# =============================================================================

.PHONY: lint
lint: ## Analise estatica (inclui code smells)
	$(call run,LINT_CMD,ex.: npx eslint . --max-warnings=0 / ruff check . / golangci-lint run)

.PHONY: lint-fix
lint-fix: ## Corrige o que o lint souber corrigir
	$(call run,LINT_FIX_CMD,ex.: npx eslint . --fix / ruff check --fix . / golangci-lint run --fix)

.PHONY: format
format: ## Formata o codigo
	$(call run,FORMAT_CMD,ex.: npx prettier --write . / ruff format . / gofmt -w .)

.PHONY: format-check
format-check: ## Verifica formatacao sem alterar arquivos
	$(call run,FORMAT_CHECK_CMD,ex.: npx prettier --check . / ruff format --check . / test -z "$$(gofmt -l .)")

.PHONY: typecheck
typecheck: ## Checagem de tipos
	$(call run,TYPECHECK_CMD,ex.: npx tsc --noEmit / mypy . — use `skip` em linguagem compilada)

# =============================================================================
# Testes
# =============================================================================

.PHONY: test
test: ## Testes unitarios e de integracao
	$(call run,TEST_CMD,ex.: npx vitest run / pytest / go test ./...)

.PHONY: test-watch
test-watch: ## Testes em modo watch
	$(call run,TEST_WATCH_CMD,ex.: npx vitest / ptw / use `skip`)

.PHONY: test-coverage
test-coverage: ## Testes com cobertura (grava em coverage/, lcov.info de preferencia)
	$(call run,TEST_COVERAGE_CMD,o SonarCloud e o comentario de PR leem coverage/ — ver sonar-project.properties)

# =============================================================================
# Banco de dados (ver docs/database.md)
# =============================================================================

.PHONY: migrate
migrate: ## Aplica as migrations pendentes
	$(call run,MIGRATE_CMD,ex.: npx prisma migrate deploy / alembic upgrade head / goose up)

.PHONY: migration
migration: ## Cria uma migration nova: make migration NAME=descricao-curta
	@[ -n "$(NAME)" ] || { printf 'uso: make migration NAME=descricao-curta\n'; exit 2; }
	$(call run,MIGRATION_CMD,ex.: npx prisma migrate dev --name $$(NAME) / alembic revision --autogenerate -m "$$(NAME)")

.PHONY: seed
seed: ## Popula o banco com os dados de desenvolvimento (todos os estados)
	$(call run,SEED_CMD,ex.: npx prisma db seed / python -m app.seed / go run ./cmd/seed)

# =============================================================================
# Contrato de API (ver ARCHITECTURE.md, secao "Contrato de API")
# =============================================================================

.PHONY: openapi
openapi: ## Gera docs/api/openapi.yaml a partir do codigo
	$(call run,OPENAPI_CMD,deve escrever docs/api/openapi.yaml — o CI falha se o commitado divergir)

# =============================================================================
# Agregados
# =============================================================================

.PHONY: validate
validate: format-check lint typecheck test ## Tudo que um PR precisa passar localmente
	@printf '\n\033[32mvalidate OK\033[0m\n'

.PHONY: ci
ci: validate build openapi ## O que o CI roda, em sequencia
	@printf '\n\033[32mci OK\033[0m\n'

# =============================================================================
# Convencoes e hooks (implementados pela fundacao, nao pelo projeto)
# =============================================================================

.PHONY: hooks
hooks: ## Ativa os hooks de git de .githooks/
	@git config core.hooksPath .githooks
	@chmod +x .githooks/* scripts/*.sh 2>/dev/null || true
	@printf '\033[36m[hooks]\033[0m core.hooksPath -> .githooks\n'

.PHONY: check-branch
check-branch: ## Valida o nome da branch atual
	@sh scripts/check-branch-name.sh

.PHONY: check-commits
check-commits: ## Valida as mensagens de commit contra a branch base
	@sh scripts/check-commit-range.sh

# =============================================================================
# Deploy
# =============================================================================

.PHONY: deploy
deploy: ## Implanta a imagem IMAGE no ambiente DEPLOY_ENV (normalmente so no CI)
	@sh scripts/deploy.sh

# =============================================================================
# Diagnostico
# =============================================================================

CONTRACT_VARS := SETUP_CMD RUN_CMD BUILD_CMD CLEAN_CMD \
                 LINT_CMD LINT_FIX_CMD FORMAT_CMD FORMAT_CHECK_CMD TYPECHECK_CMD \
                 TEST_CMD TEST_WATCH_CMD TEST_COVERAGE_CMD \
                 MIGRATE_CMD MIGRATION_CMD SEED_CMD OPENAPI_CMD

# Obrigatorios: tudo o que o CI chama. Vazio = CI vermelho; `skip` e aceito.
# Se ligar/desligar uma etapa no ci.yml, ajuste esta lista.
REQUIRED_VARS := SETUP_CMD FORMAT_CHECK_CMD LINT_CMD TYPECHECK_CMD \
                 TEST_COVERAGE_CMD BUILD_CMD OPENAPI_CMD

# Cores como caracteres reais, para poderem ser usadas com $(info) — que
# imprime sem passar pelo shell.
ESC := $(shell printf '\033')
C_RED := $(ESC)[31m
C_YEL := $(ESC)[33m
C_GRN := $(ESC)[32m
C_BLD := $(ESC)[1m
C_OFF := $(ESC)[0m

# Estado de uma variavel do contrato, ja colorido.
status = $(if $(strip $($(1))),\
           $(if $(filter skip,$(strip $($(1)))),$(C_YEL)(skip)$(C_OFF),$($(1))),\
           $(C_RED)nao configurado$(C_OFF))

# IMPORTANTE: o valor e impresso por $(info), nunca interpolado em uma linha
# de shell — um comando que contenha aspas, `<` ou `$` quebraria o recipe.
# So o NOME da variavel (controlado por nos) passa pelo printf.
row = $(info $(shell printf '  %-22s' '$(1)') $(call status,$(1)))

.PHONY: doctor
doctor: ## Mostra o que ja foi configurado em project.mk e o que falta
	$(info )
	$(info $(C_BLD)Contrato do projeto$(C_OFF))
	$(info )
	$(info $(shell printf '  %-22s %s' 'ALVO' 'COMANDO'))
	$(info $(shell printf '  %-22s %s' '----------------------' '-------'))
	$(foreach v,$(CONTRACT_VARS),$(call row,$(v)))
	$(info )
	$(info $(shell printf '  %-22s %s' 'BUILD_DIR' '$(BUILD_DIR)'))
	$(info $(shell printf '  %-22s %s' 'hooks' "$$(git config core.hooksPath 2>/dev/null || echo 'nao ativados — rode make hooks')"))
	$(info $(shell printf '  %-22s %s' 'Dockerfile' "$$([ -f Dockerfile ] && echo 'presente' || echo 'ausente — ver docker/README.md')"))
	$(info $(shell printf '  %-22s %s' 'deploy' "$$(grep -q 'DEPLOY NAO IMPLEMENTADO' scripts/deploy.sh 2>/dev/null && echo 'nao implementado — ver DEPLOY.md' || echo 'implementado')"))
	$(info )
	@files=$$(grep -rIl -e 'TODO(bootstrap)' -e SUA-ORG -e SEU-REPOSITORIO \
		--exclude-dir=.git --exclude=Makefile --exclude=BOOTSTRAP.md --exclude=SETUP-GITHUB.md \
		. 2>/dev/null || true); \
	if [ -n "$$files" ]; then \
		printf '\033[33mPlaceholders pendentes (TODO(bootstrap), SUA-ORG, SEU-REPOSITORIO) em:\033[0m\n'; \
		printf '  %s\n' $$files; \
		printf '\n'; \
	fi
	@missing=''; \
	$(foreach v,$(REQUIRED_VARS),[ -n '$(strip $($(v)))' ] || missing="$$missing $(v)";) \
	if [ -n "$$missing" ]; then \
		printf '\033[31mObrigatorios ainda nao configurados:\033[0m%s\n' "$$missing"; \
		printf 'Siga o BOOTSTRAP.md para preencher project.mk.\n\n'; \
		exit 1; \
	fi; \
	printf '\033[32mTodos os alvos obrigatorios estao configurados.\033[0m\n\n'

# Imprime o valor bruto de uma variavel do contrato.
# Usado pelos hooks de git e pelo CI para saber se um alvo ja foi configurado.
#   make -s print-LINT_CMD
.PHONY: print-%
print-%:
	$(info $($*))
	@:

.PHONY: help
help: ## Lista os alvos disponiveis
	@printf '\n\033[1mtemplate-backend\033[0m — contrato de comandos\n\n'
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(firstword $(MAKEFILE_LIST)) \
		| sort \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'
	@printf '\nComandos reais em \033[1mproject.mk\033[0m · diagnostico: \033[36mmake doctor\033[0m\n\n'
