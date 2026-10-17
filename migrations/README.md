# Migrations

Esta pasta recebe as migrations reais assim que a stack e o ORM forem
decididos ([`STACK.md`](../STACK.md), [`BOOTSTRAP.md`](../BOOTSTRAP.md)).
Algumas ferramentas usam outro caminho (ex.: `prisma/migrations`). Nesse caso,
aponte o caminho real aqui e em `.github/CODEOWNERS`, e apague esta pasta.

Regras completas em [`docs/database.md`](../docs/database.md). Em resumo:

- Toda mudança de schema é uma migration numerada: `make migration NAME=...`.
- Migration aplicada em qualquer ambiente não se edita; correção é migration nova.
- Toda migration é reversível.
- Mudança destrutiva segue expandir → contrair, em PRs separados.
- **O seed é atualizado no mesmo PR** (`make seed`).
