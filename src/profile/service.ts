import { eq } from 'drizzle-orm';

import type { Db } from '../db/context.js';
import * as schema from '../db/schema.js';

const { users } = schema;

export const LANGUAGES = ['pt-BR', 'en'] as const;
export const THEMES = ['LIGHT', 'DARK', 'SYSTEM'] as const;
export const CURRENCIES = ['BRL'] as const;

export interface Preferences {
  language: (typeof LANGUAGES)[number];
  theme: (typeof THEMES)[number];
  timezone: string;
  currency: (typeof CURRENCIES)[number];
  notifications: { inApp: boolean; email: boolean };
}

export interface PreferencesPatch {
  language?: Preferences['language'];
  theme?: Preferences['theme'];
  timezone?: string;
  currency?: Preferences['currency'];
  notifications?: { inApp?: boolean; email?: boolean };
}

/** Fuso IANA que o runtime conhece (`America/Sao_Paulo`, `UTC`...). */
export function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function toPreferences(row: typeof users.$inferSelect): Preferences {
  return {
    language: row.language as Preferences['language'],
    theme: row.theme as Preferences['theme'],
    timezone: row.timezone,
    currency: row.currency as Preferences['currency'],
    notifications: { inApp: row.notificationPrefs.in_app, email: row.notificationPrefs.email },
  };
}

/** Preferências do perfil (idioma, tema, fuso, moeda, notificações). As sessões ficam em `/v1/me/sessions`. */
export class ProfileService {
  constructor(private readonly db: Db) {}

  async get(userId: string): Promise<Preferences | null> {
    const [row] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    return row === undefined ? null : toPreferences(row);
  }

  /** `'INVALID_TIMEZONE'` se o fuso não existir. */
  async update(
    userId: string,
    patch: PreferencesPatch,
  ): Promise<Preferences | 'INVALID_TIMEZONE' | null> {
    if (patch.timezone !== undefined && !isValidTimezone(patch.timezone)) return 'INVALID_TIMEZONE';
    return this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
      if (current === undefined) return null;
      const [updated] = await tx
        .update(users)
        .set({
          ...(patch.language === undefined ? {} : { language: patch.language }),
          ...(patch.theme === undefined ? {} : { theme: patch.theme }),
          ...(patch.timezone === undefined ? {} : { timezone: patch.timezone }),
          ...(patch.currency === undefined ? {} : { currency: patch.currency }),
          ...(patch.notifications === undefined
            ? {}
            : {
                notificationPrefs: {
                  in_app: patch.notifications.inApp ?? current.notificationPrefs.in_app,
                  email: patch.notifications.email ?? current.notificationPrefs.email,
                },
              }),
        })
        .where(eq(users.id, userId))
        .returning();
      return updated === undefined ? null : toPreferences(updated);
    });
  }
}
