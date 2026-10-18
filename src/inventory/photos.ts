import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';

import { recordActivity } from '../audit/activity.js';
import { withContext, type Db } from '../db/context.js';
import { cardsInventory } from '../db/schema.js';
import {
  CONTENT_TYPE_BY_EXT,
  sniffImage,
  type FileStorage,
  type ImageKind,
} from '../storage/disk.js';

/** Máximo de fotos por carta. */
export const MAX_PHOTOS_PER_CARD = 8;
/** Tamanho máximo de uma foto (a rota limita o corpo da requisição a isto). */
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

/** O id da foto é `<uuid>.<ext>` e é o que a carta guarda em `custom_photos`. */
const PHOTO_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\.(jpg|png|webp)$/;

interface Context {
  storeId: string;
  userId: string;
}

export type AddResult =
  | { ok: true; photoId: string; photos: string[] }
  | { ok: false; reason: 'NOT_FOUND' | 'PHOTO_LIMIT' | 'PHOTO_INVALID' };
export type RemoveResult = { ok: true; photos: string[] } | { ok: false; reason: 'NOT_FOUND' };
export type ReadResult =
  { ok: true; data: Buffer; contentType: string } | { ok: false; reason: 'NOT_FOUND' };

const keyOf = (storeId: string, cardId: string, photoId: string): string =>
  `${storeId}/${cardId}/${photoId}`;

/** Fotos das cartas: o arquivo vai para o armazenamento e o id para a carta (D3: disco da VPS). */
export class PhotoService {
  constructor(
    private readonly db: Db,
    private readonly storage: FileStorage,
  ) {}

  async add(context: Context, cardId: string, data: Buffer): Promise<AddResult> {
    const kind: ImageKind | null = sniffImage(data);
    if (kind === null) return { ok: false, reason: 'PHOTO_INVALID' };
    const photoId = `${randomUUID()}.${kind.ext}`;
    const key = keyOf(context.storeId, cardId, photoId);
    let written = false;
    try {
      return await withContext(this.db, context, async (tx) => {
        const [card] = await tx
          .select({ photos: cardsInventory.customPhotos })
          .from(cardsInventory)
          .where(and(eq(cardsInventory.id, cardId), eq(cardsInventory.storeId, context.storeId)))
          .for('update')
          .limit(1);
        if (card === undefined) return { ok: false, reason: 'NOT_FOUND' } as const;
        if (card.photos.length >= MAX_PHOTOS_PER_CARD) {
          return { ok: false, reason: 'PHOTO_LIMIT' } as const;
        }
        await this.storage.put(key, data);
        written = true;
        const photos = [...card.photos, photoId];
        await tx
          .update(cardsInventory)
          .set({ customPhotos: photos, updatedAt: sql`now()` })
          .where(and(eq(cardsInventory.id, cardId), eq(cardsInventory.storeId, context.storeId)));
        await recordActivity(tx, {
          storeId: context.storeId,
          actorUserId: context.userId,
          action: 'card.photo_added',
          targetType: 'card',
          targetId: cardId,
          details: { photo_id: photoId, bytes: data.length },
        });
        return { ok: true, photoId, photos } as const;
      });
    } catch (error) {
      // O arquivo foi gravado mas a transação não confirmou: não deixa órfão.
      if (written) await this.storage.remove(key).catch(() => undefined);
      throw error;
    }
  }

  async remove(context: Context, cardId: string, photoId: string): Promise<RemoveResult> {
    if (!PHOTO_ID.test(photoId)) return { ok: false, reason: 'NOT_FOUND' };
    const result = await withContext(this.db, context, async (tx) => {
      const [card] = await tx
        .select({ photos: cardsInventory.customPhotos })
        .from(cardsInventory)
        .where(and(eq(cardsInventory.id, cardId), eq(cardsInventory.storeId, context.storeId)))
        .for('update')
        .limit(1);
      if (card === undefined || !card.photos.includes(photoId)) {
        return { ok: false, reason: 'NOT_FOUND' } as const;
      }
      const photos = card.photos.filter((item) => item !== photoId);
      await tx
        .update(cardsInventory)
        .set({ customPhotos: photos, updatedAt: sql`now()` })
        .where(and(eq(cardsInventory.id, cardId), eq(cardsInventory.storeId, context.storeId)));
      await recordActivity(tx, {
        storeId: context.storeId,
        actorUserId: context.userId,
        action: 'card.photo_removed',
        targetType: 'card',
        targetId: cardId,
        details: { photo_id: photoId },
      });
      return { ok: true, photos } as const;
    });
    if (result.ok) await this.storage.remove(keyOf(context.storeId, cardId, photoId));
    return result;
  }

  /** Lê uma foto. A carta precisa ser da loja do contexto e listar essa foto. */
  async read(context: Context, cardId: string, photoId: string): Promise<ReadResult> {
    if (!PHOTO_ID.test(photoId)) return { ok: false, reason: 'NOT_FOUND' };
    const known = await withContext(this.db, context, async (tx) => {
      const [card] = await tx
        .select({ photos: cardsInventory.customPhotos })
        .from(cardsInventory)
        .where(and(eq(cardsInventory.id, cardId), eq(cardsInventory.storeId, context.storeId)))
        .limit(1);
      return card?.photos.includes(photoId) === true;
    });
    if (!known) return { ok: false, reason: 'NOT_FOUND' };
    const data = await this.storage.get(keyOf(context.storeId, cardId, photoId));
    if (data === null) return { ok: false, reason: 'NOT_FOUND' };
    const ext = photoId.slice(photoId.lastIndexOf('.') + 1) as keyof typeof CONTENT_TYPE_BY_EXT;
    return { ok: true, data, contentType: CONTENT_TYPE_BY_EXT[ext] };
  }

  /** Apaga os arquivos de uma carta excluída (melhor esforço: a carta já foi embora). */
  async discard(storeId: string, cardId: string, photos: string[]): Promise<void> {
    await Promise.all(
      photos
        .filter((photoId) => PHOTO_ID.test(photoId))
        .map((photoId) =>
          this.storage.remove(keyOf(storeId, cardId, photoId)).catch(() => undefined),
        ),
    );
  }
}
