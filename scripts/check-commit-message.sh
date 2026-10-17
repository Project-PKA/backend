#!/usr/bin/env sh
# Valida UMA mensagem de commit (Conventional Commits).
#
#   check-commit-message.sh <arquivo-com-a-mensagem>
#   printf 'feat: algo\n' | check-commit-message.sh -
#
# Usado pelo hook commit-msg e pela validacao de titulo de PR no CI.
set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
. "$script_dir/conventions.sh"

if [ "$#" -lt 1 ]; then
  echo 'uso: check-commit-message.sh <arquivo|->' >&2
  exit 2
fi

if [ "$1" = '-' ]; then
  message=$(cat)
else
  [ -f "$1" ] || { echo "check-commit-message: arquivo nao encontrado: $1" >&2; exit 2; }
  message=$(cat "$1")
fi

# Ignora as linhas de comentario que o git adiciona ao editor.
header=$(printf '%s\n' "$message" | grep -v '^#' | sed -n '1p')

if [ -z "$header" ]; then
  echo 'Mensagem de commit vazia.'
  exit 1
fi

if reason=$(validate_commit_header "$header"); then
  echo "Commit OK: $header"
  exit 0
fi

echo ''
echo "Mensagem de commit invalida: $reason"
echo ''
echo "  $header"
print_commit_help

if [ "${GITHUB_ACTIONS:-}" = 'true' ]; then
  echo "::error title=Commit fora do padrao::$header - $reason"
fi

exit 1
