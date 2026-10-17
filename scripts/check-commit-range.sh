#!/usr/bin/env sh
# Valida todas as mensagens de commit de um intervalo.
#
#   check-commit-range.sh                # base..HEAD (base = origin/main)
#   check-commit-range.sh <base> <head>  # intervalo explicito (CI)
#
# Variaveis:
#   BASE_REF   referencia base quando nao informada (padrao: origin/main)
set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
. "$script_dir/conventions.sh"

base=${1:-${BASE_REF:-origin/main}}
head=${2:-HEAD}

if ! git rev-parse --verify --quiet "$base" >/dev/null; then
  echo "check-commit-range: base '$base' nao existe localmente." >&2
  echo "No CI, garanta fetch-depth: 0. Local: git fetch origin main" >&2
  exit 2
fi

range="$base..$head"
count=$(git rev-list --count "$range")

if [ "$count" -eq 0 ]; then
  echo "Nenhum commit em $range."
  exit 0
fi

echo "Validando $count commit(s) em $range"
echo ''

# O log vai para um arquivo (e nao para um pipe) para o laco rodar no shell
# atual e o contador de falhas sobreviver a ele.
subjects=$(mktemp)
trap 'rm -f "$subjects"' EXIT
git log --format='%s' --reverse "$range" > "$subjects"

failures=0
while IFS= read -r header || [ -n "$header" ]; do
  [ -n "$header" ] || continue
  if reason=$(validate_commit_header "$header"); then
    echo "  ok    $header"
  else
    echo "  FALHA $header"
    echo "        -> $reason"
    if [ "${GITHUB_ACTIONS:-}" = 'true' ]; then
      echo "::error title=Commit fora do padrao::$header - $reason"
    fi
    failures=$((failures + 1))
  fi
done < "$subjects"

echo ''
if [ "$failures" -gt 0 ]; then
  echo "$failures commit(s) fora do padrao."
  print_commit_help
  echo 'Com squash merge, o que fica no historico de main e o TITULO DO PR —'
  echo 'mas o CI valida os dois, para o historico da branch continuar legivel.'
  exit 1
fi

echo 'Todos os commits seguem Conventional Commits.'
