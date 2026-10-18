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
| 2b | Convites e equipe por rota, criar loja, editar loja, log de atividades, limites de HTTP | **Feita** |
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

**Etapa 4: clientes.** *Pronta, menos a exclusão LGPD.* Base com visitantes e clientes, blacklist
(com motivo), filtro de inativos pelo limite da loja, perfil 360 (acertos, histórico de lances) e
**carteira de consignação** (líquido = lance menos comissão, exige `can_view_finance`). **Falta:** exclusão
e anonimização (#43, depende da política de retenção, D2 no `OWNER.md`) e a remoção de inativos do
grupo, que é do bot (a API só lista quem está inativo). Geração do link do consignador fica na Etapa 6.

**Etapa 5: leilões e bot.** *Backend pronto; falta o bot e o agendador.* Feito: criar (agendar ou lançar agora), editar, cancelar, estender um ou todos, aprovar enquete, lance manual e alerta de WhatsApp caído, tudo sobre `place_bid` e `advance_auctions` (migration 0013). Um job do BullMQ vira o relógio de todas as lojas a cada minuto. **Falta:** o papel `bot_runtime` com RLS (#44). Descrição original: O bot é **Python + neonize** e fica **adiado** até haver conta de WhatsApp para testar ([ADR 0015](https://github.com/Project-PKA/shared/blob/main/docs/adr/0015-bot-em-python-com-neonize.md)); o motor de leilões e a função `place_bid` ([ADR 0016](https://github.com/Project-PKA/shared/blob/main/docs/adr/0016-decisao-de-lance-em-funcao-do-banco.md)) seguem no Backend e são testados sem WhatsApp. Criação a partir do cadastro da carta (**agendar,
lançar agora ou deixar para depois**), editar e cancelar, **aprovar enquete**
(aprovar encerramento ou manter aberto), **estender leilões** (+30 min por linha
e "estender todos"), decisão de lance com lock da linha do leilão, e o alerta
de **WhatsApp desconectado com leilões ativos** (o bot publica o estado; o
Backend lista os afetados).

**Etapa 6: acertos, envios e páginas públicas.** *Pronta.* O comprovante em arquivo do "já paguei" (#53) entrou com a migration 0020: `PUT /v1/public/settlement/receipt` e `GET /v1/settlements/:id/receipt`. O "já paguei" em si existe (`POST /v1/public/settlement/paid`): só avisa a loja e nunca marca como pago. Feito: fila "a acertar" por comprador, criar acerto (total = itens + frete), editar o frete, desfazer, **marcar como pago** (só a loja, exige `can_view_finance`; as cartas viram `SOLD` e entra na fila de envios) e **Envios** (a enviar, enviado, entregue, rastreio; nenhuma mensagem automática). **Falta** (precisa da sua aprovação do desenho, ver `OWNER.md` D13): papel `public_runtime` e funções `SECURITY DEFINER` (#57), página pública do acerto com consentimento LGPD (#52), "já paguei" e comprovante (#53, depende do armazenamento D3), acompanhamento do consignador (#56) e testes de abuso (#58). Descrição original: Acerto com itens, página
pública do acerto (consentimento LGPD, PIX, comprovante, "já paguei"),
**Envios** (a enviar, enviado, entregue, rastreio) e **acompanhamento do
consignador**, com as mitigações obrigatórias da [ADR 0014](https://github.com/Project-PKA/shared/blob/main/docs/adr/0014-paginas-publicas-por-link-e-vitrine.md).

**Etapa 7: painéis.** *Pronta.* `GET /v1/dashboard/home` (ao vivo, sem período) e `GET /v1/finance/overview|top-buyers|consignment-payouts` (único com período: hoje, 7, 15 ou 30 dias; exige `can_view_finance`). Receita = valor dos itens das vendas pagas, sem o frete; lucro = o valor todo nas cartas próprias (ainda não há custo de compra) e só a comissão nas consignadas; dias no fuso de São Paulo. Descrição original: **Home ao vivo** (alerta de enquetes, 5 KPIs, cartas sem
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
| Cobrança da assinatura da plataforma | Etapa 8 | Manual (fatura externa) no MVP, como o "solicitar mudança de plano" do design indica |
| "Avisar cliente no WhatsApp" | Etapa 6 | Link `wa.me` aberto pela loja, coerente com a ADR 0006 |
| Segundo fator para o administrador | Etapa 2c | Avaliar antes de produção |
| Chave do consignador (4 dígitos do CPF) | Etapa 6 | Manter só como 2º fator sobre o token do link, com limite e bloqueio (ADR 0014) |
