import { and, eq } from 'drizzle-orm';

import { recordActivity } from '../audit/activity.js';
import { withContext, type Db } from '../db/context.js';
import * as schema from '../db/schema.js';

const { storeMessageTemplates } = schema;

interface Context {
  storeId: string;
  userId: string;
}

/**
 * Textos que o bot publica no grupo (ADR 0006). Os padrões espelham `templates.py` do bot, que também
 * os tem de reserva: sem linha da loja, vale o padrão. Os marcadores são `{nome}`.
 */
export const MESSAGE_TEMPLATES = {
  card_opened: {
    placeholders: ['card', 'short_code', 'initial_bid', 'min_increment', 'ends_at'],
    defaultBody:
      '🃏 *{card}* (#{short_code})\n' +
      'Lance inicial: {initial_bid} · incremento: {min_increment}\n' +
      'Encerra: {ends_at}\n' +
      'Para dar lance, mande: #{short_code} valor',
  },
  bid_too_low: {
    placeholders: ['min_amount'],
    defaultBody: 'Lance abaixo do mínimo. O menor lance agora é {min_amount}.',
  },
  invalid_amount: {
    placeholders: ['short_code'],
    defaultBody: 'Valor inválido. Use, por exemplo: #{short_code} 50 ou #{short_code} R$ 50,00',
  },
  not_started: { placeholders: [], defaultBody: 'Esse leilão ainda não começou.' },
  ended: { placeholders: [], defaultBody: 'Esse leilão já encerrou.' },
  not_active: { placeholders: [], defaultBody: 'Esse leilão não está recebendo lances agora.' },
  ceiling_reached: {
    placeholders: ['amount'],
    defaultBody:
      'A enquete chegou ao valor máximo ({amount}). O leilão fica em validação com a loja.',
  },
  auction_won: {
    placeholders: ['winner', 'card', 'short_code', 'amount'],
    defaultBody:
      '🏆 Parabéns {winner}! {card} (#{short_code}) por {amount}. Iremos entrar em contato.',
  },
  auction_unsold: {
    placeholders: ['card', 'short_code'],
    defaultBody: 'O leilão de {card} (#{short_code}) encerrou sem lances.',
  },
} as const;

export type TemplateKey = keyof typeof MESSAGE_TEMPLATES;
export const TEMPLATE_KEYS = Object.keys(MESSAGE_TEMPLATES) as TemplateKey[];

export interface TemplateView {
  key: TemplateKey;
  placeholders: readonly string[];
  defaultBody: string;
  /** Texto da loja; `null` = usa o padrão. */
  customBody: string | null;
}

export type TemplateFailure = 'PLACEHOLDER_UNKNOWN';

const PLACEHOLDER_RE = /\{([^{}]*)\}/g;

/** Marcadores usados no texto que o modelo não oferece (ex.: `{winner}` em `bid_too_low`). */
export function unknownPlaceholders(key: TemplateKey, body: string): string[] {
  const allowed: readonly string[] = MESSAGE_TEMPLATES[key].placeholders;
  const found = [...body.matchAll(PLACEHOLDER_RE)].map((match) => match[1] ?? '');
  return [...new Set(found.filter((name) => !allowed.includes(name)))];
}

const toView = (key: TemplateKey, custom: string | undefined): TemplateView => ({
  key,
  placeholders: MESSAGE_TEMPLATES[key].placeholders,
  defaultBody: MESSAGE_TEMPLATES[key].defaultBody,
  customBody: custom ?? null,
});

/** Modelos de mensagem da loja (Configurações). Tudo no contexto da loja (RLS) e com log. */
export class MessageTemplateService {
  constructor(private readonly db: Db) {}

  async list(context: Context): Promise<TemplateView[]> {
    return withContext(this.db, context, async (tx) => {
      const rows = await tx
        .select()
        .from(storeMessageTemplates)
        .where(eq(storeMessageTemplates.storeId, context.storeId));
      const custom = new Map(rows.map((row) => [row.key, row.body]));
      return TEMPLATE_KEYS.map((key) => toView(key, custom.get(key)));
    });
  }

  async set(
    context: Context,
    key: TemplateKey,
    body: string,
  ): Promise<{ ok: true; template: TemplateView } | { ok: false; reason: TemplateFailure }> {
    const text = body.trim();
    if (unknownPlaceholders(key, text).length > 0) {
      return { ok: false, reason: 'PLACEHOLDER_UNKNOWN' };
    }
    return withContext(this.db, context, async (tx) => {
      await tx
        .insert(storeMessageTemplates)
        .values({ storeId: context.storeId, key, body: text })
        .onConflictDoUpdate({
          target: [storeMessageTemplates.storeId, storeMessageTemplates.key],
          set: { body: text, updatedAt: new Date() },
        });
      await recordActivity(tx, {
        storeId: context.storeId,
        actorUserId: context.userId,
        action: 'message_template.updated',
        targetType: 'message_template',
        details: { key },
      });
      return { ok: true, template: toView(key, text) } as const;
    });
  }

  /** Volta ao texto padrão (apaga a linha da loja). */
  async reset(context: Context, key: TemplateKey): Promise<TemplateView> {
    return withContext(this.db, context, async (tx) => {
      await tx
        .delete(storeMessageTemplates)
        .where(
          and(
            eq(storeMessageTemplates.storeId, context.storeId),
            eq(storeMessageTemplates.key, key),
          ),
        );
      await recordActivity(tx, {
        storeId: context.storeId,
        actorUserId: context.userId,
        action: 'message_template.reset',
        targetType: 'message_template',
        details: { key },
      });
      return toView(key, undefined);
    });
  }
}
