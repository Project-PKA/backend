# Estratégia de testes

> **Esqueleto do template.** Preenchido no [`BOOTSTRAP.md`](BOOTSTRAP.md),
> etapa 6, depois que a stack estiver em [`STACK.md`](STACK.md).

## Como rodar

```bash
make test            # unitários + integração
make test-coverage   # com cobertura (o CI roda este)
make test-watch      # durante o desenvolvimento
```

O CI roda `make test-coverage` em todo PR, uma única vez. O mesmo relatório
alimenta o SonarCloud e o comentário de cobertura no PR.

## Pirâmide

<!-- Proporção esperada neste projeto. Um backend típico: muitos unitários de
     domínio, integração para cada adaptador (banco, fila, API externa),
     poucos de ponta a ponta pela API. -->

| Tipo | Escopo | Ferramenta | Onde ficam |
| --- | --- | --- | --- |
| Unitário | Regras de domínio, funções puras, sem I/O | <!-- --> | <!-- --> |
| Integração | Banco real em container, filas, APIs externas mockadas no limite | <!-- --> | <!-- --> |
| Contrato | A API cumpre `docs/api/openapi.yaml` | <!-- Schemathesis, Dredd --> | <!-- --> |
| Ponta a ponta | Fluxo crítico pela API com o banco | <!-- --> | <!-- --> |

## Regras

- **Banco real nos testes de integração**, em container efêmero, com as
  migrations aplicadas antes da suíte. Mock de ORM esconde exatamente o bug
  que importa.
- **Dados de teste por factory**, criados pelo próprio teste. O seed é para
  desenvolvimento ([`docs/database.md`](docs/database.md)).
- **Teste não depende de ordem nem de outro teste.** Cada um limpa o que cria
  (transação com rollback, ou schema por teste).
- **Nada de rede real** para terceiros: stub no limite do adaptador.
- **Bug corrigido ganha teste** que falhava antes da correção.
- Teste lento (> <!-- s -->) ou instável é bug: issue com label `tech-debt`,
  nunca `skip` silencioso.

## Cobertura

- **Meta:** <!-- ex.: 70% de linhas; o valor importa menos que ele não cair -->
- **Contrato com o CI:** `TEST_COVERAGE_CMD` grava em `coverage/`
  (`lcov.info` de preferência).
- O Quality Gate do SonarCloud cobra cobertura do **código novo**.

## Critérios para merge

- [ ] `ci-success` verde
- [ ] Regra de negócio nova tem teste unitário
- [ ] Endpoint novo tem teste de integração e aparece no contrato gerado
- [ ] Migration nova foi exercitada (`up` e `down`) e o seed foi atualizado
