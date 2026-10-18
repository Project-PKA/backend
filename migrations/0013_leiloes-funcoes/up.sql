-- 0013_leiloes-funcoes: a regra de lance e a virada de estado dos leilões moram no banco (ADR 0016).
--
-- As duas funções são SECURITY INVOKER: rodam com o papel de quem chama e, portanto, sob o RLS.
-- Sem `app.store_id` definido (ou com o de outra loja) elas não enxergam o leilão: o resultado é
-- AUCTION_NOT_FOUND, nunca um dado de outra loja. Erro de regra de negócio NÃO é exceção: volta
-- como `outcome`, para o Backend (Node) e o bot (Python) tratarem do mesmo jeito.

-- Registra um lance. Trava a linha do leilão (FOR UPDATE): lances simultâneos entram um por vez,
-- cada um vendo o maior lance do anterior.
--   outcome: ACCEPTED | AUCTION_NOT_FOUND | AUCTION_NOT_ACTIVE | NOT_STARTED | ENDED |
--            CUSTOMER_NOT_FOUND | CUSTOMER_BLACKLISTED | INVALID_AMOUNT | BID_TOO_LOW
--   min_amount: o menor valor aceito agora (útil quando o lance é baixo demais).
--   ceiling_reached: enquete que atingiu o teto; o leilão fica PAUSED_FOR_VALIDATION, sem encerrar.
CREATE FUNCTION place_bid(
  p_store_id uuid,
  p_auction_id uuid,
  p_customer_id uuid,
  p_amount numeric,
  p_raw_message text,
  p_now timestamptz DEFAULT NULL
) RETURNS TABLE (
  outcome text,
  bid_id uuid,
  min_amount numeric,
  current_amount numeric,
  new_status auction_status,
  ceiling_reached boolean
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_auction auctions%ROWTYPE;
  v_blacklisted boolean;
  v_top numeric;
  v_min numeric;
  v_now timestamptz;
BEGIN
  ceiling_reached := false;

  SELECT * INTO v_auction
    FROM auctions a
   WHERE a.id = p_auction_id AND a.store_id = p_store_id
     FOR UPDATE;
  IF NOT FOUND THEN
    outcome := 'AUCTION_NOT_FOUND';
    RETURN NEXT;
    RETURN;
  END IF;
  new_status := v_auction.status;
  -- O relógio é lido DEPOIS de pegar o lock: a hora do lance segue a ordem em que foram decididos
  -- (now() seria a do início da transação, antes da espera). `p_now` existe para os testes.
  v_now := COALESCE(p_now, clock_timestamp());

  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount, 2)
     OR p_amount > 9999999999.99 THEN
    outcome := 'INVALID_AMOUNT';
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_auction.status = 'PENDING' THEN
    IF v_now < v_auction.start_time THEN
      outcome := 'NOT_STARTED';
      RETURN NEXT;
      RETURN;
    END IF;
    IF v_now >= v_auction.end_time THEN
      outcome := 'ENDED';
      RETURN NEXT;
      RETURN;
    END IF;
    -- A hora de abrir chegou: o primeiro lance abre o leilão (quem varre abre os demais).
    UPDATE auctions a SET status = 'ACTIVE' WHERE a.id = v_auction.id;
    v_auction.status := 'ACTIVE';
    new_status := 'ACTIVE';
  ELSIF v_auction.status <> 'ACTIVE' THEN
    outcome := 'AUCTION_NOT_ACTIVE';
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_now >= v_auction.end_time THEN
    outcome := 'ENDED';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT c.is_blacklisted INTO v_blacklisted
    FROM customers c
   WHERE c.id = p_customer_id AND c.store_id = p_store_id;
  IF NOT FOUND THEN
    outcome := 'CUSTOMER_NOT_FOUND';
    RETURN NEXT;
    RETURN;
  END IF;
  IF v_blacklisted THEN
    outcome := 'CUSTOMER_BLACKLISTED';
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT max(b.amount) INTO v_top
    FROM bids b
   WHERE b.auction_id = v_auction.id AND b.store_id = p_store_id;
  v_min := CASE WHEN v_top IS NULL THEN v_auction.initial_bid ELSE v_top + v_auction.min_increment END;
  min_amount := v_min;
  current_amount := v_top;
  IF p_amount < v_min THEN
    outcome := 'BID_TOO_LOW';
    RETURN NEXT;
    RETURN;
  END IF;

  INSERT INTO bids (store_id, auction_id, customer_id, amount, raw_whatsapp_message, created_at)
  VALUES (p_store_id, v_auction.id, p_customer_id, p_amount, p_raw_message, v_now)
  RETURNING id INTO bid_id;

  UPDATE customers c SET last_interaction_at = v_now WHERE c.id = p_customer_id;

  -- Enquete que chegou ao teto não fecha sozinha: o lojista decide (ADR 0004).
  IF v_auction.type = 'POLL' AND p_amount >= v_auction.max_poll_value THEN
    UPDATE auctions a
       SET status = 'PAUSED_FOR_VALIDATION', max_value_reached_alert = true
     WHERE a.id = v_auction.id;
    new_status := 'PAUSED_FOR_VALIDATION';
    ceiling_reached := true;
  ELSE
    new_status := 'ACTIVE';
  END IF;

  outcome := 'ACCEPTED';
  current_amount := p_amount;
  RETURN NEXT;
END;
$$;

-- Vira o estado dos leilões da loja de acordo com o relógio:
--   PENDING cuja hora chegou        -> ACTIVE
--   PENDING/ACTIVE cujo fim passou  -> FINISHED (vencedor = maior lance) e a carta vai para
--                                      AWAITING_CONFIRMATION; sem lance, a carta volta a AVAILABLE
-- Enquete em PAUSED_FOR_VALIDATION nunca é encerrada por aqui: espera o lojista.
-- Pode ser chamada à vontade (idempotente); quem agenda (bot, job) chama por loja.
CREATE FUNCTION advance_auctions(p_store_id uuid, p_now timestamptz DEFAULT now())
RETURNS TABLE (opened integer, finished integer, unsold integer)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row record;
  v_winner uuid;
BEGIN
  opened := 0;
  finished := 0;
  unsold := 0;

  UPDATE auctions a
     SET status = 'ACTIVE'
   WHERE a.store_id = p_store_id AND a.status = 'PENDING'
     AND a.start_time <= p_now AND a.end_time > p_now;
  GET DIAGNOSTICS opened = ROW_COUNT;

  FOR v_row IN
    SELECT a.id, a.card_id
      FROM auctions a
     WHERE a.store_id = p_store_id AND a.status IN ('PENDING', 'ACTIVE') AND a.end_time <= p_now
     ORDER BY a.id
       FOR UPDATE
  LOOP
    SELECT b.id INTO v_winner
      FROM bids b
     WHERE b.auction_id = v_row.id AND b.store_id = p_store_id
     ORDER BY b.amount DESC
     LIMIT 1;

    UPDATE auctions a SET status = 'FINISHED', winning_bid_id = v_winner WHERE a.id = v_row.id;
    UPDATE cards_inventory c
       SET status = CASE WHEN v_winner IS NULL THEN 'AVAILABLE'::card_status
                         ELSE 'AWAITING_CONFIRMATION'::card_status END,
           updated_at = p_now
     WHERE c.id = v_row.card_id AND c.store_id = p_store_id;

    finished := finished + 1;
    IF v_winner IS NULL THEN unsold := unsold + 1; END IF;
  END LOOP;

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION place_bid(uuid, uuid, uuid, numeric, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION advance_auctions(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION place_bid(uuid, uuid, uuid, numeric, text, timestamptz) TO app_runtime;
GRANT EXECUTE ON FUNCTION advance_auctions(uuid, timestamptz) TO app_runtime;
