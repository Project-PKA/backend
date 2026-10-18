#!/usr/bin/env sh
# =============================================================================
# Teste de restauração: abre um backup criptografado e restaura num banco NOVO e descartável
# (`restore_check`), nunca por cima do banco real. Confere que o schema e os dados voltaram e apaga
# o banco de teste. Rode de tempos em tempos: backup que nunca foi restaurado não é backup.
#
#   sh restore.sh backups/20261018T031700Z.dump.enc
#
# Para RESTAURAR DE VERDADE (desastre): pare a API, restaure em outro banco com --keep, confira, e só
# então troque o nome (ALTER DATABASE ... RENAME) ou aponte DB_NAME. Passo a passo em DEPLOY.md.
#
#   sh restore.sh arquivo.dump.enc --keep    # mantém o banco `restore_check` para inspeção
# =============================================================================
set -eu

file=${1:-}
keep=${2:-}
if [ -z "$file" ] || [ ! -f "$file" ]; then
  echo 'uso: sh restore.sh backups/<arquivo>.dump.enc [--keep]' >&2
  exit 2
fi

cd "$(dirname "$0")"
set -a
# shellcheck disable=SC1091
. ./.env
set +a
: "${BACKUP_PASSPHRASE:?defina BACKUP_PASSPHRASE no .env}"
DB_OWNER_USER=${DB_OWNER_USER:-owner}
COMPOSE=${COMPOSE:-docker compose --env-file .env --env-file image.env}
scratch=restore_check

psql_admin() {
  # shellcheck disable=SC2086
  $COMPOSE exec -T db psql -U "$DB_OWNER_USER" -d postgres -v ON_ERROR_STOP=1 -At "$@"
}

psql_admin -c "DROP DATABASE IF EXISTS $scratch" >/dev/null
psql_admin -c "CREATE DATABASE $scratch" >/dev/null

# Descriptografa e restaura. Erros de papel (o dump referencia app_runtime etc.) são esperados no
# banco novo; o que importa é o schema e os dados.
# shellcheck disable=SC2086
BACKUP_PASSPHRASE="$BACKUP_PASSPHRASE" openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -pass env:BACKUP_PASSPHRASE -in "$file" \
  | $COMPOSE exec -T db pg_restore -U "$DB_OWNER_USER" -d "$scratch" --no-owner --no-privileges --exit-on-error

tables=$(psql_admin -d "$scratch" -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")
users=$(psql_admin -d "$scratch" -c "SELECT count(*) FROM users")
migrations=$(psql_admin -d "$scratch" -c "SELECT count(*) FROM schema_migrations" 2>/dev/null || echo '?')
echo "restore: tabelas=$tables usuarios=$users migrations=$migrations"

if [ "$tables" -lt 20 ]; then
  echo 'restore: poucas tabelas, a restauração parece incompleta' >&2
  exit 1
fi
if [ "$keep" != '--keep' ]; then
  psql_admin -c "DROP DATABASE $scratch" >/dev/null
  echo 'restore: ok (banco de teste apagado)'
else
  echo "restore: ok (banco '$scratch' mantido para inspeção)"
fi
