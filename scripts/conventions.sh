#!/usr/bin/env sh
# =============================================================================
# Definicao unica das convencoes de branch e commit.
#
# FONTE: IgorOCosta/workflows, tooling/conventions.sh. Os templates carregam uma copia em
# scripts/ (usada pelos hooks de git locais); o CI de todos os projetos usa
# esta versao central, via o workflow reutilizavel conventions.yml.
# Para propagar uma mudanca para as copias: tooling/sync-templates.sh
#
# Sem dependencia de runtime: so POSIX sh. Mensagens em ASCII.
# Ao mudar algo aqui, atualize o CONVENCOES.md (codex-base) e rode tooling/test-conventions.sh.
# =============================================================================

# Tipos de Conventional Commits aceitos.
CONVENTIONAL_TYPES='feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert'

# Prefixos de branch aceitos (trunk-based: todas nascem de main e morrem no merge).
BRANCH_PREFIXES='feature|fix|hotfix|release|chore|docs|refactor|test'

# Unica branch de longa duracao.
BRANCH_EXEMPT='main'

# Branches criadas por automacao, que nao controlamos o nome.
#   dependabot/...              Dependabot
#   renovate/...                Renovate
#   release-please--...         PR de release do release-please
BRANCH_BOT_PATTERN='^(dependabot/|renovate/|release-please--)'

# Tamanho maximo do cabecalho do commit.
COMMIT_HEADER_MAX=100

# ERE para o cabecalho:  tipo(escopo opcional)!: descricao
commit_header_pattern() {
  printf '^(%s)(\\([a-z0-9._/-]+\\))?!?: .+$' "$CONVENTIONAL_TYPES"
}

branch_pattern() {
  printf '^((%s)|(%s)/[a-z0-9._-]+)$' "$BRANCH_EXEMPT" "$BRANCH_PREFIXES"
}

is_bot_branch() {
  printf '%s' "$1" | grep -Eq "$BRANCH_BOT_PATTERN"
}

# Cabecalhos gerados pelo proprio git ou pelo GitHub, que nao seguem a convencao.
is_generated_header() {
  case "$1" in
    'Merge '*|'Revert "'*|'fixup! '*|'squash! '*|'amend! '*|'Initial commit') return 0 ;;
    *) return 1 ;;
  esac
}

# Valida um cabecalho. Ecoa o motivo e devolve 1 quando invalido.
validate_commit_header() {
  header="$1"

  if is_generated_header "$header"; then
    return 0
  fi

  if [ "${#header}" -gt "$COMMIT_HEADER_MAX" ]; then
    echo "cabecalho com ${#header} caracteres (maximo $COMMIT_HEADER_MAX)"
    return 1
  fi

  if ! printf '%s' "$header" | grep -Eq "$(commit_header_pattern)"; then
    echo "fora do padrao 'tipo(escopo): descricao'"
    return 1
  fi

  # Descricao depois dos dois pontos.
  subject=${header#*: }

  case "$subject" in
    [A-Z]*)
      echo 'a descricao deve comecar em minuscula'
      return 1
      ;;
  esac

  case "$subject" in
    *.)
      echo 'a descricao nao deve terminar com ponto'
      return 1
      ;;
  esac

  return 0
}

print_commit_help() {
  cat <<HELP

  Formato:  <tipo>(<escopo opcional>): <descricao no imperativo>

  Tipos:    $(printf '%s' "$CONVENTIONAL_TYPES" | tr '|' ' ')

  Exemplos:
    feat(checkout): valida cupom antes de habilitar o botao
    fix(http): trata timeout como erro recuperavel
    docs(testing): explica o criterio de componente vs e2e
    feat(api)!: remove o campo legado de resposta

  Regras: descricao no imperativo, minuscula, sem ponto final,
          cabecalho de ate $COMMIT_HEADER_MAX caracteres.

  Detalhes em CONTRIBUTING.md.
HELP
}

print_branch_help() {
  cat <<HELP

  Formato:  <prefixo>/<slug-em-minusculas>

  Prefixos: $(printf '%s' "$BRANCH_PREFIXES" | tr '|' ' ')

  O slug aceita a-z, 0-9, ponto, hifen e underscore.

  Exemplos:
    feature/filtro-por-data
    fix/timeout-no-login
    hotfix/erro-500-no-checkout

  Detalhes em CONTRIBUTING.md.
HELP
}
