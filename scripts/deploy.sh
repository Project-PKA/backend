#!/usr/bin/env sh
# =============================================================================
# Deploy na VPS: docker compose por SSH (receita de DEPLOY.md).
#
# O workflow `.github/workflows/deploy.yml` cuida do que não depende da plataforma (gatilhos,
# Environment, aprovação, build único da imagem, smoke test). Este arquivo é o único que sabe ONDE a
# imagem roda: copia o compose e o Caddyfile para a VPS, puxa a imagem, roda as migrations com ela,
# cria/atualiza o papel da API e troca a versão.
#
# Contrato de entrada (definido pelo workflow):
#   DEPLOY_ENV   dev | test | homolog | prod
#   IMAGE        imagem já publicada (ghcr.io/org/repo:<sha>)
# Do Environment (secrets e variables):
#   SSH_HOST, SSH_USER, SSH_PRIVATE_KEY, SSH_KNOWN_HOSTS    acesso à VPS (usuário SEM root)
#   GHCR_PULL_USER, GHCR_PULL_TOKEN                          a VPS puxar a imagem privada
#   DEPLOY_DIR (opcional)                                    padrão /srv/pokemon-auction/<ambiente>
#
# Na VPS já devem existir (preparados uma vez, DEPLOY.md): o diretório, o `.env` do ambiente (modelo
# deploy/env.example, chmod 600) e o Docker. O `.env` NUNCA passa por este script nem pelo repositório.
#
# Saída: 0 = implantado. Qualquer outro código falha o deploy.
# =============================================================================
set -eu

DEPLOY_ENV=${DEPLOY_ENV:-}
IMAGE=${IMAGE:-}
if [ -z "$DEPLOY_ENV" ] || [ -z "$IMAGE" ]; then
  echo 'deploy: DEPLOY_ENV e IMAGE precisam estar definidos.' >&2
  echo 'Rode pelo workflow de deploy, ou: DEPLOY_ENV=dev IMAGE=ghcr.io/org/repo:<sha> make deploy' >&2
  exit 2
fi

for name in SSH_HOST SSH_USER SSH_PRIVATE_KEY SSH_KNOWN_HOSTS GHCR_PULL_USER GHCR_PULL_TOKEN; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    echo "deploy: falta $name (secret ou variable do Environment $DEPLOY_ENV; ver docs/secrets.md, seção 3)." >&2
    exit 2
  fi
done

case "$DEPLOY_ENV" in
  dev | test | homolog | prod) ;;
  *) echo "deploy: ambiente inválido: $DEPLOY_ENV" >&2; exit 2 ;;
esac
# A imagem e o diretório vão para um comando remoto: aceita só caracteres de nome de imagem e caminho.
case "$IMAGE" in
  *[!A-Za-z0-9./:_@-]*) echo 'deploy: IMAGE com caracteres inválidos.' >&2; exit 2 ;;
esac
DEPLOY_DIR=${DEPLOY_DIR:-/srv/pokemon-auction/$DEPLOY_ENV}
case "$DEPLOY_DIR" in
  /*[!A-Za-z0-9/_.-]* | '') echo 'deploy: DEPLOY_DIR inválido.' >&2; exit 2 ;;
esac

echo "deploy: ambiente=$DEPLOY_ENV imagem=$IMAGE destino=$SSH_USER@$SSH_HOST:$DEPLOY_DIR"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
key="$tmp/deploy_key"
umask 077
printf '%s\n' "$SSH_PRIVATE_KEY" > "$key"
printf '%s\n' "$SSH_KNOWN_HOSTS" > "$tmp/known_hosts"
chmod 600 "$key"

ssh_opts="-i $key -o UserKnownHostsFile=$tmp/known_hosts -o StrictHostKeyChecking=yes -o BatchMode=yes"
remote="$SSH_USER@$SSH_HOST"

# 1) O compose, o Caddyfile e os scripts de backup versionados no repositório vão junto com a imagem.
# shellcheck disable=SC2086
scp $ssh_opts deploy/compose.prod.yaml "$remote:$DEPLOY_DIR/compose.yaml"
# shellcheck disable=SC2086
scp $ssh_opts deploy/Caddyfile "$remote:$DEPLOY_DIR/Caddyfile"
# shellcheck disable=SC2086
scp $ssh_opts deploy/backup.sh deploy/restore.sh "$remote:$DEPLOY_DIR/"

# 2) Login no GHCR sem deixar o token em argumento (vai pela entrada padrão), troca de versão e
#    migrations ANTES de subir a API, com a mesma imagem e o papel dono.
# shellcheck disable=SC2086
printf '%s' "$GHCR_PULL_TOKEN" | ssh $ssh_opts "$remote" "set -eu
cd '$DEPLOY_DIR'
test -f .env || { echo 'deploy: falta $DEPLOY_DIR/.env na VPS (modelo: deploy/env.example)' >&2; exit 3; }
docker login ghcr.io -u '$GHCR_PULL_USER' --password-stdin >/dev/null
printf 'IMAGE=%s\n' '$IMAGE' > image.env
compose='docker compose --env-file .env --env-file image.env'
\$compose pull api migrate provision
\$compose up -d db redis
\$compose --profile tools run --rm migrate
\$compose --profile tools run --rm provision
\$compose up -d --remove-orphans
# Espera a API ficar pronta (migrations aplicadas, banco e Redis respondendo) antes de dar por feito.
for attempt in \$(seq 1 30); do
  if \$compose exec -T api node -e \"fetch('http://127.0.0.1:8080/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"; then
    echo 'deploy: API pronta.'
    exit 0
  fi
  sleep 4
done
echo 'deploy: a API não ficou pronta a tempo. Últimas linhas do log:' >&2
\$compose logs --tail 40 api >&2
exit 1"
