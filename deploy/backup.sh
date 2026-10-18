#!/usr/bin/env sh
# =============================================================================
# Backup do Postgres: pg_dump comprimido e CRIPTOGRAFADO (AES-256), com retenção.
#
# Roda na VPS, no diretório do ambiente (onde está o compose.yaml e o .env), por cron:
#   17 3 * * *  cd /srv/pokemon-auction/prod && sh backup.sh >> backup.log 2>&1
#
# Lê do .env: DB_OWNER_USER, DB_NAME, BACKUP_PASSPHRASE e (opcional) BACKUP_KEEP_DAYS (padrão 14).
# Grava em ./backups/<data>.dump.enc. A frase NÃO pode ficar só na VPS: guarde uma cópia em
# gerenciador de senhas; sem ela o backup não abre. Teste a restauração (restore.sh) antes de precisar.
#
# Variável COMPOSE (opcional): comando do compose. Padrão: docker compose --env-file .env --env-file image.env
# =============================================================================
set -eu

cd "$(dirname "$0")"
set -a
# shellcheck disable=SC1091
. ./.env
set +a

: "${BACKUP_PASSPHRASE:?defina BACKUP_PASSPHRASE no .env}"
DB_OWNER_USER=${DB_OWNER_USER:-owner}
DB_NAME=${DB_NAME:-app}
KEEP_DAYS=${BACKUP_KEEP_DAYS:-14}
COMPOSE=${COMPOSE:-docker compose --env-file .env --env-file image.env}

mkdir -p backups
umask 077
stamp=$(date -u +%Y%m%dT%H%M%SZ)
final="backups/$stamp.dump.enc"
partial="$final.partial"

# pg_dump em formato custom (permite pg_restore seletivo), comprimido, e criptografado em seguida.
# A frase vai pelo ambiente do openssl, nunca em argumento (apareceria na lista de processos).
# shellcheck disable=SC2086
$COMPOSE exec -T db pg_dump -U "$DB_OWNER_USER" -d "$DB_NAME" -Fc --compress=6 \
  | BACKUP_PASSPHRASE="$BACKUP_PASSPHRASE" openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
      -pass env:BACKUP_PASSPHRASE -out "$partial"

# Só vale se o arquivo tem conteúdo; um dump vazio (falha silenciosa no pipe) não substitui nada.
if [ ! -s "$partial" ]; then
  rm -f "$partial"
  echo "backup: arquivo vazio, falhou" >&2
  exit 1
fi
mv "$partial" "$final"
echo "backup: $final ($(wc -c < "$final") bytes)"

# Retenção: apaga os mais antigos que KEEP_DAYS dias.
find backups -name '*.dump.enc' -mtime "+$KEEP_DAYS" -print -delete
