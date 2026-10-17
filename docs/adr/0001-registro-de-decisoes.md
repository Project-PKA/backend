# 0001 — Registro de decisões arquiteturais (ADR)

## Status

Aceito

## Contexto

Este projeto usa Architecture Decision Records (ADRs) para registrar decisões
técnicas significativas e o raciocínio por trás delas, de forma que futuros
mantenedores entendam *por que* algo foi feito de determinado jeito — não só
*o quê*.

Decisões que afetam **mais de um repositório** do projeto (contrato de API,
autenticação entre serviços, formato de evento) não ficam aqui: ficam no
`docs/adr/` do repositório docs/shared.

## Decisão

Toda decisão arquitetural relevante (escolha de stack, padrão de comunicação
entre serviços, estratégia de autenticação, escolha de banco de dados, etc.)
é registrada como um novo arquivo `docs/adr/NNNN-titulo-curto.md`, numerado
sequencialmente, usando este arquivo como template.

### Template para novos ADRs

```markdown
# NNNN — Título curto no imperativo

## Status

Proposto | Aceito | Depreciado | Substituído por ADR-XXXX

## Contexto

Qual problema/força motivou esta decisão? Que restrições existiam?

## Decisão

O que foi decidido, de forma direta.

## Consequências

O que fica mais fácil ou mais difícil como resultado desta decisão?
Trade-offs aceitos conscientemente.

## Alternativas consideradas

O que mais foi avaliado e por que foi descartado.

## Quando reabrir

Que fato tornaria esta decisão errada.
```

## Consequências

- Decisões importantes ficam rastreáveis e revisáveis.
- ADRs não são editados após aceitos; uma mudança de direção gera um novo ADR
  que referencia e substitui o anterior.
