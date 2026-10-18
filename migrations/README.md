# Migrations

Migrations SQL escritas à mão, uma pasta por migration, com `up.sql` e
`down.sql`: `migrations/NNNN_nome-em-kebab/`. O Drizzle não gera `down`
([`STACK.md`](../STACK.md), seção 3). O runner está em `src/db/migrator.ts` e
guarda o checksum do `up.sql`: editar uma migration já aplicada falha.

```bash
make migration NAME=cria-lojas   # cria 000N_cria-lojas/{up,down}.sql
make migrate                     # aplica as pendentes
npm run db:rollback              # reverte a última
npm run db:status                # aplicada ou pendente
```

Regras completas em [`docs/database.md`](../docs/database.md). Em resumo:

- Toda mudança de schema é uma migration numerada: `make migration NAME=...`.
- `src/db/schema.ts` (tipos do Drizzle) acompanha cada migration no mesmo PR.
- Migration aplicada em qualquer ambiente não se edita; correção é migration nova.
- Toda migration é reversível.
- Mudança destrutiva segue expandir → contrair, em PRs separados.
- **O seed é atualizado no mesmo PR** (`make seed`).
