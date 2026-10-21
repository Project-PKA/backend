import { eq } from 'drizzle-orm';

import {
  maskCpfLast2,
  normalizeCep,
  normalizeCpf,
  normalizePhone,
} from '../customers/validation.js';
import type { Db } from '../db/context.js';
import * as schema from '../db/schema.js';
import type { CpfVault } from '../security/cpf-vault.js';

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

export interface PersonalAddress {
  zip: string | null;
  street: string | null;
  number: string | null;
  comp: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
}

export interface PersonalData {
  name: string | null;
  phone: string | null;
  birthDate: string | null;
  /** Nunca o CPF inteiro. */
  cpfMasked: string | null;
  address: PersonalAddress;
}

export interface PersonalPatch {
  name?: string;
  phone?: string | null;
  birthDate?: string | null;
  cpf?: string | null;
  address?: Partial<PersonalAddress>;
}

export type PersonalFailure =
  'PHONE_INVALID' | 'CPF_INVALID' | 'CEP_INVALID' | 'BIRTH_DATE_INVALID';

const MIN_BIRTH_YEAR = 1900;

/** `AAAA-MM-DD` real, de 1900 até hoje. */
export function isValidBirthDate(value: string, today = new Date()): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  const real =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return real && year >= MIN_BIRTH_YEAR && date.getTime() <= today.getTime();
}

export const EMPTY_PERSONAL: PersonalData = {
  name: null,
  phone: null,
  birthDate: null,
  cpfMasked: null,
  address: {
    zip: null,
    street: null,
    number: null,
    comp: null,
    neighborhood: null,
    city: null,
    state: null,
  },
};

function toPersonal(row: typeof users.$inferSelect): PersonalData {
  return {
    name: row.name,
    phone: row.phone,
    birthDate: row.birthDate,
    cpfMasked: maskCpfLast2(row.cpfLast2),
    address: {
      zip: row.addressZip,
      street: row.addressStreet,
      number: row.addressNumber,
      comp: row.addressComp,
      neighborhood: row.addressNeighborhood,
      city: row.addressCity,
      state: row.addressState,
    },
  };
}

type UserValues = Partial<typeof users.$inferInsert>;

type Parsed = { ok: true; values: UserValues } | { ok: false; reason: PersonalFailure };

export type PersonalResult =
  { ok: true; data: PersonalData } | { ok: false; reason: PersonalFailure | 'NOT_FOUND' };

function addressValues(address: Partial<PersonalAddress>): Parsed {
  const values: UserValues = {};
  if (address.zip !== undefined) {
    const zip = address.zip === null ? null : normalizeCep(address.zip);
    if (address.zip !== null && zip === null) return { ok: false, reason: 'CEP_INVALID' };
    values.addressZip = zip;
  }
  if (address.street !== undefined) values.addressStreet = address.street;
  if (address.number !== undefined) values.addressNumber = address.number;
  if (address.comp !== undefined) values.addressComp = address.comp;
  if (address.neighborhood !== undefined) values.addressNeighborhood = address.neighborhood;
  if (address.city !== undefined) values.addressCity = address.city;
  if (address.state !== undefined) values.addressState = address.state?.toUpperCase() ?? null;
  return { ok: true, values };
}

/** Valida e normaliza só o que veio (telefone, CEP e nascimento são conferidos no servidor). */
function personalValues(patch: PersonalPatch): Parsed {
  const values: UserValues = {};
  if (patch.name !== undefined) values.name = patch.name.trim();
  if (patch.phone !== undefined) {
    const phone = patch.phone === null ? null : normalizePhone(patch.phone);
    if (patch.phone !== null && phone === null) return { ok: false, reason: 'PHONE_INVALID' };
    values.phone = phone;
  }
  if (patch.birthDate !== undefined) {
    if (patch.birthDate !== null && !isValidBirthDate(patch.birthDate)) {
      return { ok: false, reason: 'BIRTH_DATE_INVALID' };
    }
    values.birthDate = patch.birthDate;
  }
  if (patch.address === undefined) return { ok: true, values };
  const address = addressValues(patch.address);
  return address.ok ? { ok: true, values: { ...values, ...address.values } } : address;
}

/** Preferências do perfil (idioma, tema, fuso, moeda, notificações). As sessões ficam em `/v1/me/sessions`. */
export class ProfileService {
  constructor(
    private readonly db: Db,
    private readonly vault: CpfVault,
  ) {}

  /** Dados pessoais da própria pessoa. O CPF só sai mascarado. */
  async getPersonal(userId: string): Promise<PersonalData | null> {
    const [row] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    return row === undefined ? null : toPersonal(row);
  }

  /**
   * Edita os dados pessoais de quem está logado (`PATCH /v1/me`). Só os campos enviados mudam; `null`
   * limpa. O CPF é validado, cifrado com o `CpfVault` (ADR 0019) e nunca devolvido nem logado.
   */
  async updatePersonal(userId: string, patch: PersonalPatch): Promise<PersonalResult> {
    const parsed = personalValues(patch);
    if (!parsed.ok) return parsed;
    const { values } = parsed;
    if (patch.cpf !== undefined) {
      if (patch.cpf === null) {
        values.cpf = null;
        values.cpfLast2 = null;
      } else {
        const cpf = normalizeCpf(patch.cpf);
        if (cpf === null) return { ok: false, reason: 'CPF_INVALID' };
        const sealed = this.vault.seal(cpf);
        values.cpf = sealed.cipher;
        values.cpfLast2 = sealed.last2;
      }
    }
    const [row] =
      Object.keys(values).length === 0
        ? await this.db.select().from(users).where(eq(users.id, userId)).limit(1)
        : await this.db.update(users).set(values).where(eq(users.id, userId)).returning();
    return row === undefined
      ? { ok: false, reason: 'NOT_FOUND' }
      : { ok: true, data: toPersonal(row) };
  }

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
