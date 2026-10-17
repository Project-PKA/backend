# Banco de dados: ORM, migrations e seeds

> Regras que valem para qualquer stack. O ORM e a ferramenta de migration
> reais são escolhidos no [`BOOTSTRAP.md`](../BOOTSTRAP.md) e registrados em
> [`STACK.md`](../STACK.md). Os comandos ficam em `project.mk`:
> `MIGRATE_CMD`, `MIGRATION_CMD` e `SEED_CMD`.

## 1. O que o ORM precisa entregar

A escolha é livre, desde que entregue os dois pontos abaixo. Sem eles, a
escolha precisa de justificativa em `STACK.md`.

- **Schema versionado.** Toda mudança de tabela é uma migration numerada e
  reversível, commitada no repositório. Nunca se altera o banco à mão, em
  nenhum ambiente.
- **Type safety.** O ORM gera tipos a partir do schema, ou o schema é a
  fonte dos tipos. Uma coluna renomeada ou removida quebra a **compilação**
  do código que a usa, em vez de falhar em produção.

| Stack | ORM / query builder | Migrations |
| --- | --- | --- |
| Node/TypeScript | Prisma (schema-first) ou Drizzle (SQL-like, type-safe) | Embutidas |
| Python | SQLAlchemy 2.0 com type hints | Alembic |
| Go | sqlc (tipos a partir de SQL) ou GORM | golang-migrate / goose |
| Java/Kotlin | jOOQ (mais type safety) ou JPA/Hibernate | Flyway / Liquibase |
| C#/.NET | Entity Framework Core | Embutidas no EF Core |

Prisma, Drizzle e sqlc já nascem gerando tipos do schema. Com JPA ou GORM
puro, esse cuidado vira item de revisão de PR.

## 2. Migrations

- `make migration NAME=descricao-curta` cria, `make migrate` aplica.
- Uma migration aplicada em **qualquer** ambiente nunca mais é editada. Uma
  correção é uma migration nova.
- Toda migration tem `down` (ou o equivalente da ferramenta) testado.
- Mudança destrutiva (drop de coluna, rename, mudança de tipo) é feita em
  duas etapas, para a versão anterior da aplicação continuar funcionando
  durante o deploy:
  1. **Expandir:** adicionar o novo, escrever nos dois, fazer backfill.
  2. **Contrair:** remover o antigo, em um PR seguinte, depois do deploy.
- Migration com dado em produção (backfill, drop) exige aprovação humana
  (`AGENTS.md`, seção 6).
- **Em deploy:** as migrations rodam com a **mesma imagem** que vai ser
  implantada, antes da troca de versão (`scripts/deploy.sh`, `DEPLOY.md`).

### Banco compartilhado com outro serviço

Se um microservice lê ou escreve nas tabelas deste backend:

- As migrations dessas tabelas continuam **só aqui**. Duas fontes alterando o
  mesmo schema é quebra garantida.
- O microservice acessa com usuário/role próprio, restrito às tabelas que
  precisa. A lista fica no `ARCHITECTURE.md` dele e no daqui.
- Mudança nessas tabelas é mudança de contrato: avise o dono do serviço
  antes do merge.

## 3. Seeds

O seed é o banco de desenvolvimento e de teste. Ele precisa cobrir o máximo
de cenários, não só o caminho feliz:

- **Um registro de cada estado relevante de cada entidade.** Por exemplo,
  pedido pendente, pago, cancelado e estornado, e não "um pedido qualquer".
- **Casos de borda que já causaram bug:** nulo onde é permitido, string
  vazia, data no limite (fim de mês, fuso, 29/02), relacionamento opcional
  sem preenchimento, texto com acento e emoji.
- **Volume suficiente para notar problema de paginação e de performance.**
  Não adianta ter 3 registros se a tela pagina de 20 em 20.
- **Determinístico.** Rodar duas vezes dá o mesmo resultado: use IDs fixos ou
  semente fixa no gerador.
- **O seed usa o client do ORM, não SQL solto.** Assim ele também se beneficia
  do type safety e quebra o build se ficar dessincronizado do schema.

**O seed evolui junto com a migration.** Toda migration que adiciona coluna,
tabela ou constraint atualiza o seed **no mesmo PR**. Um seed desatualizado
quebra, em silêncio, o ambiente de quem roda o projeto depois. O template de
PR cobra isso.

| Stack | Seed |
| --- | --- |
| Node/TypeScript | `prisma db seed` ou script com o client do Drizzle |
| Python | Script com a mesma sessão do SQLAlchemy (`python -m app.seed`) |
| Go | `go run ./cmd/seed` com o client do sqlc/GORM |
| Java/Kotlin | Migration de dados separada no Flyway/Liquibase, só em dev/test |
| C#/.NET | `HasData` do EF Core ou script separado |

## 4. Dados de teste

Testes de integração sobem um banco real e efêmero (container), aplicam as
migrations e usam **factories** para os dados de cada teste, em vez de
depender do seed. O seed é para desenvolvimento e demonstração; o teste
cria o que precisa. Ver [`TESTING.md`](../TESTING.md).
