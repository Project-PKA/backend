# Estratégia de testes

## Como rodar

```bash
make test            # unitários + integração
make test-coverage   # com cobertura (o CI roda este)
make test-watch      # durante o desenvolvimento
```

Os testes de integração sobem um **Postgres real em container** (Testcontainers),
então o **Docker precisa estar rodando**. Na primeira vez, baixar a imagem
`postgres:17-alpine` leva alguns minutos.

O CI roda `make test-coverage` em todo PR, uma única vez. O mesmo relatório
(`coverage/lcov.info`) alimenta o SonarCloud e o comentário de cobertura no PR.

## Pirâmide

Muitos unitários de regra de negócio, integração para cada adaptador (banco,
fila, API externa) e poucos testes de ponta a ponta pela API.

| Tipo | Escopo | Ferramenta | Onde ficam |
| --- | --- | --- | --- |
| Unitário | Regras puras, sem I/O (ex.: `loadEnv`, parser de lance) e rotas via `app.inject` | Vitest | `test/*.test.ts` |
| Integração | Banco real em container: migrations, schema, seed, constraints, rotas com banco | Vitest + Testcontainers | `test/*.integration.test.ts` |
| Contrato | A API cumpre `docs/api/openapi.yaml` | Schemathesis (a avaliar) | pendente |
| Ponta a ponta | Fluxo crítico pela API com o banco | Vitest sobre `app.inject` | a partir da Etapa 2 |

## O que já está coberto

- **Migrations:** aplica tudo, reverte tudo (`down`) e reaplica; não sobra
  tabela nem enum; migration editada depois de aplicada é recusada; falha no
  meio desfaz a transação inteira; os `.sql` são UTF-8 sem BOM.
- **Schema:** `schema.ts` tem as mesmas tabelas, colunas, tipos e nulabilidade
  do banco migrado (anti-drift).
- **Seed:** determinístico (rodar duas vezes dá o mesmo banco) e cobre todos
  os estados de cada entidade.
- **Integridade:** FK entre lojas, carta consignada sem dono, enquete sem
  teto, segundo leilão aberto na mesma carta, lance repetido, acerto pago sem
  data, entre outras.
- **Infra HTTP:** `/health`, `/ready` (200 e 503 contra o banco real),
  `/metrics`, 404 e erro em `problem+json`, propagação do `traceparent`.

## Regras

- **Banco real nos testes de integração**, em container efêmero, com as
  migrations aplicadas antes da suíte. Mock de ORM esconde exatamente o bug
  que importa.
- **Dados de teste por factory**, criados pelo próprio teste. O seed é para
  desenvolvimento ([`docs/database.md`](docs/database.md)). Hoje alguns testes
  de schema usam o seed de propósito, porque é ele que está sendo validado.
- **Teste não depende de ordem nem de outro teste.** Cada um limpa o que cria
  (transação com rollback, ou banco recriado por `resetDatabase`).
- **Nada de rede real** para terceiros (TCGdex, e-mail, WhatsApp): stub no
  limite do adaptador.
- **Rota nova tem teste de acesso cruzado entre lojas**: uma loja não lê nem
  altera dado de outra, nem por `x-store-id` trocado nem por ID na URL.
- **Bug corrigido ganha teste** que falhava antes da correção.
- **Regra de segurança tem teste** (ver [`SECURITY.md`](SECURITY.md)): OTP
  expirado, tentativas esgotadas, refresh reutilizado, permissão negada.
- Teste lento (> 30 s) ou instável é bug: issue com label `tech-debt`, nunca
  `skip` silencioso.

## Concorrência de lances

O motor de leilões (Etapa 5) precisa de teste que dispare **lances
simultâneos** no mesmo leilão, com o banco real, e confira que: o maior valor
vence, nenhum lance abaixo do incremento é aceito e dois lances do mesmo valor
não coexistem. A decisão e o lock estão em `ARCHITECTURE.md`.

## Cobertura

- **Piso:** 70% de linhas, instruções, funções e branches (`vitest.config.ts`);
  o valor importa menos que ele não cair. Hoje está acima de 90% em linhas.
- Ficam fora da cobertura só os pontos de entrada finos: `src/server.ts`,
  `src/db/cli.ts` e `src/db/seed-cli.ts`.
- **Contrato com o CI:** `TEST_COVERAGE_CMD` grava em `coverage/`
  (`lcov.info`), apontado em `sonar-project.properties`.
- O Quality Gate do SonarCloud cobra cobertura do **código novo**.

## Critérios para merge

- [ ] `ci-success` verde
- [ ] Regra de negócio nova tem teste unitário
- [ ] Endpoint novo tem teste de integração, teste de acesso cruzado entre lojas e aparece no contrato gerado
- [ ] Migration nova foi exercitada (`up` e `down`), o `schema.ts` e o seed foram atualizados
