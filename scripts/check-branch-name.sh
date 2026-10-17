#!/usr/bin/env sh
# Valida o nome de uma branch contra as convencoes de conventions.sh.
#
#   check-branch-name.sh [nome-da-branch]
#
# Sem argumento, usa a branch do HEAD. No CI de pull request, passe
# $GITHUB_HEAD_REF (via variavel de ambiente, nunca interpolado no script) —
# o HEAD ali aponta para um merge commit destacado.
set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
. "$script_dir/conventions.sh"

branch=${1:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')}

if [ -z "$branch" ] || [ "$branch" = 'HEAD' ]; then
  echo 'check-branch-name: nao foi possivel determinar a branch.' >&2
  echo 'Passe o nome como argumento.' >&2
  exit 2
fi

if is_bot_branch "$branch"; then
  echo "Branch de automacao, isenta da regra: $branch"
  exit 0
fi

if printf '%s' "$branch" | grep -Eq "$(branch_pattern)"; then
  echo "Branch OK: $branch"
  exit 0
fi

echo ''
echo "Nome de branch invalido: $branch"
print_branch_help

# Anotacao nativa do GitHub Actions, quando rodando no CI.
if [ "${GITHUB_ACTIONS:-}" = 'true' ]; then
  echo "::error title=Nome de branch invalido::'$branch' nao segue o padrao exigido."
fi

exit 1
