# Stack

> **Esqueleto do template.** Este repositório não escolhe stack: ele fornece
> o **formato** para registrar as escolhas do projeto e o critério para
> fazê-las. As perguntas de cada seção são conduzidas pelo
> [`BOOTSTRAP.md`](BOOTSTRAP.md).
>
> O valor deste arquivo não está na lista de ferramentas, mas em registrar
> o **critério** e a **alternativa descartada**. Daqui a um ano, quando
> alguém perguntar "por que não usamos X?", a resposta precisa estar escrita.

---

## O formato

Para cada escolha relevante, registre cinco coisas:

1. **Escolha:** o que foi adotado, com versão.
2. **Critério:** o que importava na hora de decidir.
3. **Por quê:** como a escolha atende o critério.
4. **Descartado:** o que mais foi considerado e por que não.
5. **Quando reabrir:** que fato tornaria essa decisão errada.

---

## Resumo

<!-- Preencha durante o bootstrap. Versões exatas do runtime ficam em
     .tool-versions; os comandos, em project.mk. -->

| Camada | Escolha | Versão | Seção |
| --- | --- | --- | --- |
| Linguagem e runtime | <!-- --> | <!-- --> | 1 |
| Framework HTTP | <!-- --> | <!-- --> | 2 |
| Banco e ORM/migrations | <!-- --> | <!-- --> | 3 |
| Lint, formatação, tipos | <!-- --> | <!-- --> | 4 |
| Testes | <!-- --> | <!-- --> | 5 |
| Observabilidade | <!-- --> | <!-- --> | 6 |
| Plataforma de deploy | <!-- --> | — | 7 |

---

## 1. Linguagem e runtime

**Critérios que costumam importar:** o que o time domina, o que a
organização já opera, o ecossistema para os requisitos da etapa 2 (filas,
tempo real, integrações) e o custo de contratação.

**Escolha:** <!-- -->
**Critério:** <!-- -->
**Por quê:** <!-- -->
**Descartado:** <!-- -->
**Quando reabrir:** <!-- -->

## 2. Framework HTTP

**Requisito da fundação:** gerar OpenAPI **a partir do código**
(`make openapi`).

**Escolha:** <!-- --> · **Geração de OpenAPI:** <!-- lib -->
**Critério / Por quê / Descartado / Quando reabrir:** <!-- -->

## 3. Banco de dados e ORM

**Requisitos da fundação** ([`docs/database.md`](docs/database.md)):
migrations numeradas e reversíveis, e tipos gerados do schema.

**Banco:** <!-- --> · **ORM:** <!-- --> · **Migrations:** <!-- -->
**Compartilhado com outro serviço?** <!-- não / sim: quem e quais tabelas -->
**Critério / Por quê / Descartado / Quando reabrir:** <!-- -->

## 4. Lint, formatação e tipos

**Requisito da fundação:** o lint cobre **code smells e complexidade**, além
dos erros básicos, porque alimenta o Quality Gate do SonarCloud.

| Papel | Ferramenta | Observação |
| --- | --- | --- |
| Lint | <!-- --> | |
| Formatação | <!-- --> | |
| Tipos | <!-- --> | <!-- `skip` em linguagem compilada --> |
| SonarCloud | Projeto inteiro | Duplicação, cobertura de código novo, hotspots |

## 5. Testes

**Framework:** <!-- --> · **Integração com banco real:** <!-- testcontainers / compose -->
**Cobertura:** grava em `coverage/` (`TEST_COVERAGE_CMD`); caminho real
em `sonar-project.properties`.
**Estratégia completa:** [`TESTING.md`](TESTING.md)

## 6. Observabilidade

| Sinal | Biblioteca |
| --- | --- |
| Logs JSON | <!-- --> |
| Métricas Prometheus | <!-- --> |
| Tracing OpenTelemetry | <!-- SDK + exporter --> |

## 7. Plataforma de deploy

**Escolha:** <!-- Kubernetes / Cloud Run / ECS / VPS / ... -->
**Critério / Por quê / Descartado / Quando reabrir:** <!-- -->
Receita e rollback em [`DEPLOY.md`](DEPLOY.md).

## 8. Dispensas conscientes

<!-- Todo `skip` em project.mk e todo "não usamos X" da fundação (ex.:
     `sonar: false`) com o motivo e quando revisitar. -->

| O que foi dispensado | Motivo | Revisitar quando |
| --- | --- | --- |
| <!-- --> | <!-- --> | <!-- --> |
