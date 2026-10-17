#!/usr/bin/env sh
# =============================================================================
# PONTO DE EXTENSAO DO DEPLOY
#
# O workflow `.github/workflows/deploy.yml` cuida da parte que NAO depende da
# plataforma: gatilhos, escolha do GitHub Environment, aprovacao manual,
# build unico da imagem, garantia de que a imagem existe, smoke test e
# resumo. No fim, ele chama `make deploy`, que chama este script.
#
# Este arquivo e o unico lugar que sabe ONDE a imagem roda. Trocar de
# plataforma (Kubernetes, Cloud Run, ECS, uma VPS com docker compose) e
# reescrever este arquivo — nenhum workflow muda.
#
# Receitas prontas: DEPLOY.md
#
# -----------------------------------------------------------------------------
# Contrato de entrada
# -----------------------------------------------------------------------------
#   DEPLOY_ENV    dev | test | homolog | prod   (sempre definido pelo workflow)
#   IMAGE         imagem ja publicada, com tag = SHA (ghcr.io/org/repo:<sha>)
#   APP_BASE_URL  URL publica do ambiente, se configurada
#
#   Tudo o mais (cluster, servico, host, token) vem das secrets e variables
#   daquele GitHub Environment — ver SETUP-GITHUB.md.
#
# Saida: 0 = implantado. Qualquer outro codigo falha o deploy.
# Migrations: rode-as AQUI, antes de trocar a versao (ou como job/initContainer
# da plataforma), sempre com a MESMA imagem. Ver docs/database.md.
# =============================================================================
set -eu

DEPLOY_ENV=${DEPLOY_ENV:-}
IMAGE=${IMAGE:-}

if [ -z "$DEPLOY_ENV" ] || [ -z "$IMAGE" ]; then
  echo 'deploy: DEPLOY_ENV e IMAGE precisam estar definidos.' >&2
  echo 'Rode pelo workflow de deploy, ou: DEPLOY_ENV=dev IMAGE=ghcr.io/org/repo:<sha> make deploy' >&2
  exit 2
fi

echo "deploy: ambiente=$DEPLOY_ENV imagem=$IMAGE"

# -----------------------------------------------------------------------------
# IMPLEMENTE AQUI.
#
# Apague o bloco abaixo e coloque os comandos da sua plataforma.
# Copie a receita correspondente de DEPLOY.md.
# -----------------------------------------------------------------------------

cat <<'PENDING' >&2

  ============================================================
   DEPLOY NAO IMPLEMENTADO
  ============================================================

  A plataforma de deploy ainda nao foi escolhida para este projeto.

  1. Decida a plataforma  -> BOOTSTRAP.md, etapa de deploy
  2. Copie a receita      -> DEPLOY.md
  3. Implemente aqui      -> scripts/deploy.sh
  4. Configure os Environments com secrets e variables
                          -> SETUP-GITHUB.md, secao B4

  Ate la, o workflow de deploy falha de proposito: melhor falhar
  explicito do que publicar em lugar nenhum e reportar sucesso.

PENDING

exit 1
