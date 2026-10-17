# Docker

Exemplos, não configuração ativa. O template não sabe qual é a stack, então
não pode entregar um `Dockerfile` que funcione. Um `Dockerfile` quebrado na
raiz é pior que nenhum: o CI acusaria erro em todo PR, sem apontar o motivo.

## Como usar

1. Copie o exemplo para a raiz:

   ```sh
   cp docker/Dockerfile.example Dockerfile
   ```

2. Troque cada `TODO(bootstrap)` pelos comandos reais da stack, os mesmos
   de `project.mk`.
3. Valide localmente: `docker build -t api:local .`
4. Suba junto do banco: `docker compose --profile app up --build`.

A partir daí, o CI (job "Imagem Docker") valida o build em todo PR, e o
`deploy.yml` publica a imagem no GHCR no push em `main`.

## Banco local sem Docker da aplicação

O `compose.yaml` da raiz já sobe o Postgres sozinho, desde o primeiro dia:

```sh
docker compose up -d db
```

O serviço `app` fica no profile `app` e só sobe quando pedido
(`--profile app`), porque depende do `Dockerfile` da raiz.

## Configuração em runtime

A imagem é a mesma de `dev` a `prod`. O que muda entre ambientes chega por
variável de ambiente no momento do deploy, vinda das variables/secrets do
GitHub Environment. Nunca use `ARG`/`ENV` para gravar URL, credencial ou
flag de ambiente na imagem.
