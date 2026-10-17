# Roteiro de entrega (revisado em 2026-10-17)

> O backlog original (doc 02, Etapas 1 a 6) foi escrito antes do design. O
> adendo do design ([`shared/docs/produto.md`](https://github.com/Project-PKA/shared/blob/main/docs/produto.md))
> trouxe acesso por convite, área `/admin`, páginas públicas, envios, planos e
> mais. Este roteiro reorganiza as etapas. Ele é a referência para "o que falta".

**Escopo, regras e telas:** `shared/docs/produto.md`.
**Decisões:** ADRs 0002 a 0014 do `shared`.

## Estado

| Etapa | Conteúdo | Situação |
| --- | --- | --- |
| 1 | Scaffold, schema base (12 tabelas), migrations `up`/`down`, seed | **Feita** |
| 2a | Identidade, login por convite, RLS, tenant e RBAC | **Feita** |
| 2b | Convites e equipe por rota, criar loja, log de atividades | Pendente |
| 2c | API `/v1/admin` e solicitações de acesso | Pendente |
| 3 | Catálogo TCGdex, estoque e cadastro de carta | Pendente |
| 4 | Clientes, visitantes, blacklist e carteira de consignação | Pendente |
| 5 | Leilões e integração com o bot | Pendente |
| 6 | Acertos, envios e páginas públicas | Pendente |
| 7 | Painéis (Home ao vivo e Financeiro) | Pendente |
| 8 | Vitrine, landing, planos, notificações, log e perfil | Pendente |

## Etapa 2: identidade, administração e isolamento

O adendo mudou o desenho que estava planejado (login aberto + `POST /stores`).
A etapa fica em três entregas, nesta ordem:

**2a. Base de identidade e isolamento** (feita em 2026-10-17: migrations 0008 e 0009,
`src/auth/`, rotas `/v1/auth`, `/v1/me` e `/v1/store`, 137 testes)

- Papéis de banco (`owner`, `app_runtime`) e **RLS** nas tabelas de loja, com
  contexto por transação ([ADR 0011](https://github.com/Project-PKA/shared/blob/main/docs/adr/0011-row-level-security-como-segunda-barreira.md)).
- Usuário com estado (`INVITED`, `ACTIVE`, `SUSPENDED`), `is_platform_admin`,
  `can_create_stores`, `store_limit` e `last_login_at`.
- Login OTP **só para conta existente**; resposta igual para e-mail
  desconhecido ([ADR 0012](https://github.com/Project-PKA/shared/blob/main/docs/adr/0012-acesso-somente-por-convite-e-administracao-da-plataforma.md)).
  JWT curto + refresh rotacionado, logout, lista e revogação de sessões.
- Middleware de loja (`x-store-id`), RBAC e hardening (helmet, CORS, rate limit,
  redação de log).
- Comando de linha para criar o primeiro administrador (`db:create-admin`).

**2b. Convites, lojas e equipe**

- Convites por rota (o serviço de criar, mostrar e aceitar já existe; faltam as rotas de
  equipe, reenviar e revogar).
- Lojas: listar as minhas, criar (só com permissão global e dentro do limite),
  ler e editar. Equipe: convidar, ajustar permissões, remover.
- Log de atividades (base) para ações sensíveis.

**2c. API `/v1/admin`**

- Usuários (listar, cadastrar, detalhe, permissões globais, suspender,
  reenviar convite), lojas (listar, criar, transferir propriedade), convites e
  **solicitações de acesso** (`POST` público com proteção contra abuso).
- O administrador **não** lê nem altera estoque, clientes, leilões, lances nem
  acertos: garantido por RLS e coberto por teste.

> **Excluir loja** ficou de fora: apagar uma loja leva embora todos os dados
> dela (CPF, endereços, lances). Precisa da política de retenção e exclusão da
> revisão de LGPD antes de existir.

## Etapas seguintes

**Etapa 3: catálogo e estoque.** Sync do catálogo às 03:00 (BullMQ), busca
`ILIKE` com `pg_trgm`, CRUD de carta com **Observações**, origem **sem valor
padrão**, "cartas sem leilão" (derivado), detalhe com histórico, upload de fotos
(depende da decisão de armazenamento), exclusão com permissão.

**Etapa 4: clientes.** Base, visitantes, blacklist, inatividade, perfil 360 e
**carteira de consignação**. Geração do link do consignador fica na Etapa 6.

**Etapa 5: leilões e bot.** Criação a partir do cadastro da carta (**agendar,
lançar agora ou deixar para depois**), editar e cancelar, **aprovar enquete**
(aprovar encerramento ou manter aberto), **estender leilões** (+30 min por linha
e "estender todos"), decisão de lance com lock da linha do leilão, e o alerta
de **WhatsApp desconectado com leilões ativos** (o bot publica o estado; o
Backend lista os afetados).

**Etapa 6: acertos, envios e páginas públicas.** Acerto com itens, página
pública do acerto (consentimento LGPD, PIX, comprovante, "já paguei"),
**Envios** (a enviar, enviado, entregue, rastreio) e **acompanhamento do
consignador**, com as mitigações obrigatórias da [ADR 0014](https://github.com/Project-PKA/shared/blob/main/docs/adr/0014-paginas-publicas-por-link-e-vitrine.md).

**Etapa 7: painéis.** **Home ao vivo** (alerta de enquetes, 5 KPIs, cartas sem
leilão, acertos rápidos; sem período e sem rankings) e **Financeiro** (único com
período: séries diárias, histogramas, pizzas, top compradores, repasses). Os
endpoints de período do doc 02 (`dashboard/operational?period=`) **não existem
mais**.

**Etapa 8: vitrine, planos e perfil.** Vitrine pública (com opt-in da loja),
landing (SEO) no frontend, planos e uso, notificações, log de atividades
(só proprietário) e perfil (preferências, sessões ativas).

## Mudanças de schema previstas

Tudo por migration `up`/`down`, com `schema.ts` e seed no mesmo PR.

| Etapa | Mudança |
| --- | --- |
| 2a | `users`: nome, `status`, `is_platform_admin`, `can_create_stores`, `store_limit`, `last_login_at`. `refresh_tokens`: agente de usuário e IP (sessões ativas). Papéis de banco, grants e políticas de RLS |
| 2b | `invitations`; `activity_log`; `stores`: cidade, plano, limite de membros |
| 2c | `access_requests` |
| 3 | `cards_inventory`: `notes` |
| 5 | `auctions`: início imediato, estado de extensão; relação com o estado do WhatsApp da loja |
| 6 | `settlements`: token do link, consentimento, comprovante, "já paguei"; `shipments`; `consignor_links` (token, expiração, tentativas, bloqueio) |
| 7 | Nada novo previsto; consultas agregadas |
| 8 | `plans`/uso, `notifications`, preferências do usuário (idioma, tema, fuso, moeda), `stores`: opt-in da vitrine, chave PIX |

## Impacto nos outros repositórios

- **whatsapp_microservice:** publicar o estado de conexão por loja; sinalizar
  que lances podem ter sido perdidos numa queda; abrir o leilão na hora para
  "lançar agora"; respeitar o RLS (ADR 0011).
- **frontend_web:** o design (protótipo em baixa fidelidade) é a fonte das
  telas; tipos virão do contrato gerado aqui.
- **shared:** o contrato OpenAPI passa a ter áreas `/v1/admin` e `/v1/public`.

## Decisões em aberto que travam etapas

| Decisão | Trava | Recomendação |
| --- | --- | --- |
| Provedor de e-mail (convite e OTP) | Etapa 2b (convites reais) | Decidir antes de `homolog`; até lá, log em desenvolvimento |
| Armazenamento de arquivos (fotos, avatar, comprovante) | Etapas 3, 6 e 8 | Disco da VPS com backup no início; bucket quando crescer |
| Cobrança da assinatura da plataforma | Etapa 8 | Manual (fatura externa) no MVP, como o "solicitar mudança de plano" do design indica |
| "Avisar cliente no WhatsApp" | Etapa 6 | Link `wa.me` aberto pela loja, coerente com a ADR 0006 |
| Segundo fator para o administrador | Etapa 2c | Avaliar antes de produção |
| Chave do consignador (4 dígitos do CPF) | Etapa 6 | Manter só como 2º fator sobre o token do link, com limite e bloqueio (ADR 0014) |
