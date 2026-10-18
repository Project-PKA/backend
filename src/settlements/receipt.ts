import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';

import { withContext, type Db } from '../db/context.js';
import { settlements } from '../db/schema.js';
import { CONTENT_TYPE_BY_EXT, sniffImage, type FileStorage } from '../storage/disk.js';

/** Tamanho máximo do comprovante (a rota limita o corpo a isto). */
export const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;

export type ReceiptOutcome = 'OK' | 'ALREADY_PAID' | 'RECEIPT_EXISTS' | 'INVALID_FILE';

interface Context {
  storeId: string;
  userId: string;
}

const keyOf = (file: string): string => `receipts/${file}`;

/**
 * Comprovante do "já paguei". O comprador envia pelo link público; a loja baixa pela rota
 * autenticada. O arquivo é gravado ANTES de a função do banco validar o link (ela precisa do nome)
 * e apagado se a resposta não for OK, então um token errado nunca deixa arquivo para trás.
 */
export class ReceiptService {
  constructor(
    private readonly db: Db,
    private readonly storage: FileStorage,
  ) {}

  /** `null` = link inválido (igual a todo motivo, ADR 0014). */
  async attach(token: string, ip: string, data: Buffer): Promise<ReceiptOutcome | null> {
    const kind = sniffImage(data);
    if (kind === null) return 'INVALID_FILE';
    const file = `${randomUUID()}.${kind.ext}`;
    await this.storage.put(keyOf(file), data);
    let outcome: ReceiptOutcome | null = null;
    try {
      outcome = await this.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE public_runtime`);
        const result = await tx.execute<{ outcome: { result: ReceiptOutcome } | null }>(
          sql`SELECT public_settlement_receipt_attach(${token}::text, ${ip}::text, ${file}::text) AS outcome`,
        );
        return result.rows[0]?.outcome?.result ?? null;
      });
    } finally {
      if (outcome !== 'OK') await this.storage.remove(keyOf(file)).catch(() => undefined);
    }
    return outcome;
  }

  /** Lê o comprovante de um acerto da loja. `null` se não há acerto, comprovante ou arquivo. */
  async read(
    context: Context,
    settlementId: string,
  ): Promise<{ data: Buffer; contentType: string } | null> {
    const file = await withContext(this.db, context, async (tx) => {
      const [row] = await tx
        .select({ file: settlements.receiptFile })
        .from(settlements)
        .where(and(eq(settlements.id, settlementId), eq(settlements.storeId, context.storeId)))
        .limit(1);
      return row?.file ?? null;
    });
    if (file === null) return null;
    const data = await this.storage.get(keyOf(file));
    if (data === null) return null;
    const ext = file.slice(file.lastIndexOf('.') + 1) as keyof typeof CONTENT_TYPE_BY_EXT;
    return { data, contentType: CONTENT_TYPE_BY_EXT[ext] };
  }

  /** Apaga o arquivo de um acerto desfeito (melhor esforço: o acerto já foi embora). */
  async discard(file: string | null): Promise<void> {
    if (file === null) return;
    await this.storage.remove(keyOf(file)).catch(() => undefined);
  }
}
