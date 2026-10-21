# Roteiro de entrega (revisado em 2026-10-21)

> O backlog original (doc 02, Etapas 1 a 6) foi escrito antes do design. O
> adendo do design ([`shared/docs/produto.md`](https://github.com/Project-PKA/shared/blob/main/docs/produto.md))
> trouxe acesso por convite, área `/admin`, páginas públicas, planos e
> mais. Este roteiro reorganiza as etapas. Ele é a referência para "o que falta".

**Escopo, regras e telas:** `shared/docs/produto.md`.
**Decisões:** ADRs 0002 a 0014 do `shared`.

## Estado

| Etapa | Conteúdo | Situação |
| --- | --- | --- |
| 1 | Scaffold, schema base (12 tabelas), migrations `up`/`down`, seed | **Feita** |
| 2a | Identidade, login por convite, RLS, tenant e RBAC | **Feita** |
| 2b | Convites e equipe por rota, criar loja, editar loja, log de atividades, limites de HTTP | **Feita** |
| 2c | API `/v1/admin` e solicitações de acesso | **Feita** |
| 3 | Catálogo TCGdex, estoque e cadastro de carta | **Feita** |
| 4 | Clientes, visitantes, blacklist e carteira de consignação | **Feita**, menos a anonimização LGPD (em revisão, Backend#117) |
| 5 | Leilões e integração com o bot | **Feita** no Backend (`place_bid`, `advance_auctions` e o papel `bot_runtime`, migrations 0013 e 0021). O bot está no `whatsapp_microservice` e ainda não foi exercitado com WhatsApp de verdade (`OWNER.md` A11) |
| 6 | Acertos e páginas públicas | **Feita** |
| 7 | Painéis (Home ao vivo e Financeiro) | **Feita** |
| 8 | Vitrine, landing, planos, notificações, log e perfil | **Feita**, sem cobrança (D6: sem cobrança no MVP) |

## O que falta para fechar o MVP (Sprint 09)

O que está por fazer, na ordem do milestone "Sprint 09 - Fechar o MVP e testar de ponta a ponta" do `shared`:

- **Pedidos do frontend** ([shared#37](https://github.com/Project-PKA/shared/issues/37)): feitos em PRs de rascunho (link `/invite`, filtro de idioma, filtros e autor do log, convite pendente do usuário, dados novos do cliente, pedido de permissão). Falta o `PATCH /v1/me` (Backend#105), parado numa decisão do dono: guardar ou não o CPF do usuário.
- **LGPD**: anonimização de cliente (shared#39, em revisão) e rotação da chave do CPF (shared#47, em revisão). Retenção por prazo, "excluir loja" e texto jurídico seguem para quando houver loja real.
- **Segurança** ([shared#43](https://github.com/Project-PKA/shared/issues/43)): log sem dado pessoal, com teste; itens restantes do `SECURITY.md` dependem da VPS.
- **Pareamento do WhatsApp pelo painel** ([shared#36](https://github.com/Project-PKA/shared/issues/36)): proposta de migration e rotas comentada na issue, aguardando aprovação (papel de banco e RLS).
- **Fora do Backend**: bot (`whatsapp_microservice`), frontend, VPS e deploy (`OWNER.md`, A7).

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

**2b. Convites, lojas e equipe** (feita em 2026-10-17: migration 0010, `POST /v1/stores`, `PATCH /v1/store`, `/v1/team*` e `/v1/activity-log`, 187 testes)

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

## Etapa 2c: administração da plataforma (pronta)

`/v1/admin` (só administrador): usuários (listar, buscar, detalhe, cadastrar com convite de conta, permissões globais, suspender e reativar derrubando as sessões), lojas (listar, criar com proprietário novo ou existente, transferir propriedade sem nunca zerar os proprietários), convites (listar, reenviar, revogar), solicitações de acesso (listar, recusar, converter ao criar a loja), painel com KPIs e lojas com WhatsApp desconectado, e o log de atividades da plataforma. A landing envia o pedido por `POST /v1/public/access-requests` (não cria usuário nem loja e não manda e-mail). Cidade, plano e **limite de membros** da loja são definidos pela administração; o limite vale para os convites da equipe.

> **Excluir loja** continua de fora (ver acima).

## Etapas seguintes

**Etapa 3: catálogo e estoque.** *Pronta.* Sync do catálogo às 03:00
(BullMQ, `npm run catalog:sync` para a carga inicial), busca sem acento com
`pg_trgm`, CRUD de carta com **Observações**, origem **sem valor padrão**,
"cartas sem leilão" (`no_auction`), detalhe com histórico e exclusão com
permissão. **Fotos (#38):** `PUT /v1/cards/:id/photos` com a imagem crua no corpo (JPEG, PNG ou
WebP, até 5 MB, 8 por carta, tipo conferido pelos primeiros bytes, nome gerado pelo servidor),
`GET`/`DELETE /v1/cards/:id/photos/:photoId`. Os arquivos ficam no disco da VPS (D3), fora de qualquer
pasta pública; o download exige login e a loja da carta (o frontend busca com `fetch` e usa o blob).

**Etapa 4: clientes.** *Pronta, menos a anonimização LGPD (Backend#117, em revisão).* Base com visitantes e clientes, blacklist
(com motivo), filtro de inativos pelo limite da loja, perfil 360 (acertos, histórico de lances) e
**carteira de consignação** (líquido = lance menos comissão, exige `can_view_finance`). **Falta:** a
anonimização sob pedido (#43; a postura mínima da D2 está na ADR 0019, o PR #117 espera revisão) e a remoção de inativos do
grupo, que é do bot (a API só lista quem está inativo). Geração do link do consignador fica na Etapa 6.

**Etapa 5: leilões e bot.** *Backend pronto.* Feito: criar (agendar ou lançar agora), editar, cancelar, estender um ou todos, aprovar enquete, lance manual e alerta de WhatsApp caído, tudo sobre `place_bid` e `advance_auctions` (migration 0013). Um job do BullMQ vira o relógio de todas as lojas a cada minuto. O papel `bot_runtime` com RLS está pronto (migration 0021, D15) e o bot vive no `whatsapp_microservice`. Descrição original: O bot é **Python + neonize** e fica **adiado** até haver conta de WhatsApp para testar ([ADR 0015](https://github.com/Project-PKA/shared/blob/main/docs/adr/0015-bot-em-python-com-neonize.md)); o motor de leilões e a função `place_bid` ([ADR 0016](https://github.com/Project-PKA/shared/blob/main/docs/adr/0016-decisao-de-lance-em-funcao-do-banco.md)) seguem no Backend e são testados sem WhatsApp. Criação a partir do cadastro da carta (**agendar,
lançar agora ou deixar para depois**), editar e cancelar, **aprovar enquete**
(aprovar encerramento ou manter aberto), **estender leilões** (+30 min por linha
e "estender todos"), decisão de lance com lock da linha do leilão, e o alerta
de **WhatsApp desconectado com leilões ativos** (o bot publica o estado; o
Backend lista os afetados).

**Etapa 6: acertos e páginas públicas.** *Pronta.* O comprovante em arquivo do "já paguei" (#53) entrou com a migration 0020: `PUT /v1/public/settlement/receipt` e `GET /v1/settlements/:id/receipt`. O "já paguei" em si existe (`POST /v1/public/settlement/paid`): só avisa a loja e nunca marca como pago. Feito: fila "a acertar" por comprador, criar acerto (total = soma dos itens), desfazer, **marcar como pago** (só a loja, exige `can_view_finance`; as cartas viram `SOLD`). **Frete e envio saíram do sistema** (migration 0022, decisão do dono em shared#8): a loja combina isso por fora. O desenho das páginas públicas foi aprovado (D13): papel `public_runtime`, funções `SECURITY DEFINER`, página do acerto com consentimento LGPD, "já paguei" e comprovante, acompanhamento do consignador e testes de abuso estão prontos. Descrição original: Acerto com itens, página
pública do acerto (consentimento LGPD, PIX, comprovante, "já paguei"),
**Acompanhamento do
consignador**, com as mitigações obrigatórias da [ADR 0014](https://github.com/Project-PKA/shared/blob/main/docs/adr/0014-paginas-publicas-por-link-e-vitrine.md).

**Etapa 7: painéis.** *Pronta.* `GET /v1/dashboard/home` (ao vivo, sem período) e `GET /v1/finance/overview|top-buyers|consignment-payouts` (único com período: hoje, 7, 15 ou 30 dias; exige `can_view_finance`). Receita = valor dos itens das vendas pagas; lucro = o valor todo nas cartas próprias (ainda não há custo de compra) e só a comissão nas consignadas; dias no fuso de São Paulo. Descrição original: **Home ao vivo** (alerta de enquetes, 5 KPIs, cartas sem
leilão, acertos rápidos; sem período e sem rankings) e **Financeiro** (único com
período: séries diárias, histogramas, pizzas, top compradores, repasses). Os
endpoints de período do doc 02 (`dashboard/operational?period=`) **não existem
mais**.

**Etapa 8 (pronta, menos cobrança e faturas):** perfil (`/v1/me/preferences`: idioma `pt-BR`/`en`, tema, fuso, moeda, notificações), notificações internas por loja com leitura por pessoa, plano (`/v1/plan`: limites, uso, pedido de mudança que chega ao administrador; limite de cartas e de membros valem nas ações) e vitrine pública opt-in (`GET /v1/public/showcase`, função `SECURITY DEFINER`, teto de página e de deslocamento, limite por minuto). Cobrança e faturas dependem da D6. Descrição original:

**Etapa 8: vitrine, planos e perfil.** Vitrine pública (com opt-in da loja),
landing (SEO) no frontend, planos e uso, notificações, log de atividades
(só proprietário) e perfil (preferências, sessões ativas).

## Mudanças de schema previstas

Tudo por migration `up`/`down`, com `schema.ts` e seed no mesmo PR.

| Etapa | Mudança |
| --- | --- |
| 2a | `users`: nome, `status`, `is_platform_admin`, `can_create_stores`, `store_limit`, `last_login_at`. `refresh_tokens`: agente de usuário e IP (sessões ativas). Papéis de banco, grants e políticas de RLS |
| 2b | `activity_log` (feito, migration 0010). Ficam para a 2c: `stores`: cidade, plano, limite de membros |
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
| Provedor de e-mail (convite e OTP) | Etapa 2b (convites reais) | **Decidido:** SMTP do Gmail por enquanto (D1); trocar por provedor transacional antes de crescer (issue no `shared`) |
| Armazenamento de arquivos (fotos, avatar, comprovante) | Etapas 3, 6 e 8 | **Decidido (D3):** disco da VPS, no backup; bucket quando crescer (a porta `FileStorage` permite trocar) |
| Cobrança da assinatura da plataforma | Etapa 8 | **Decidido (D6):** sem cobrança no MVP; o plano é só um rótulo com limites |
| "Avisar cliente no WhatsApp" | Etapa 6 | **Retirado (D7, ADR 0018):** o bot só fala no grupo |
| Segundo fator para o administrador | Etapa 2c | **Decidido (D4):** não terá; login por código e promoção só por linha de comando |
| Chave do consignador (4 dígitos do CPF) | Etapa 6 | Feito como 2º fator sobre o token do link, com limite e bloqueio (ADR 0014); a chave sai do HMAC do CPF cifrado (ADR 0019) |
| Pareamento do WhatsApp pelo painel (QR e grupos) | Tela "Nova loja" | **Em aberto (D20):** proposta de desenho comentada em shared#36, aguardando aprovação do dono |
| Guardar o CPF do usuário (`PATCH /v1/me`) | Backend#105 | **Em aberto:** a recomendação é não guardar; se guardar, usar o `CpfVault` (ADR 0019) |
