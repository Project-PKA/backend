# Git hooks

Hooks versionados, sem dependencia de runtime (POSIX `sh` puro). Nao ha
Husky nem `npm install` envolvido: qualquer stack usa os mesmos hooks.

## Ativacao

```sh
make hooks     # ou: git config core.hooksPath .githooks
```

`make setup` ja faz isso. Git nao ativa hooks versionados sozinho — e
preciso apontar `core.hooksPath` uma vez por clone.

## O que roda

| Hook | Quando | O que faz |
| --- | --- | --- |
| `pre-commit` | Antes de criar o commit | `make lint` e `make format-check` se estiverem configurados |
| `commit-msg` | Com a mensagem escrita | Valida Conventional Commits |
| `pre-push` | Antes de enviar | Valida o nome da branch e roda `make typecheck` |

As regras de nome de branch e de commit vivem em `scripts/conventions.sh`,
o mesmo arquivo que o CI usa — local e pipeline nao podem divergir.

## Pular um hook

`git commit --no-verify` existe, mas o CI aplica as mesmas regras: pular
aqui so adia a falha. Se um hook atrapalha de forma legitima, conserte a
regra em um PR proprio.
