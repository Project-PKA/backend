import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Porta de armazenamento de arquivos. Hoje é o disco da VPS; trocar por S3 não muda o resto. */
export interface FileStorage {
  put: (key: string, data: Buffer) => Promise<void>;
  /** `null` se o arquivo não existe. */
  get: (key: string) => Promise<Buffer | null>;
  /** Não falha se o arquivo já não existe. */
  remove: (key: string) => Promise<void>;
}

const UUID = '[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}';

/**
 * Chaves têm forma fixa `<loja>/<carta>/<arquivo>`, com uuid e extensão conhecida. Nada que venha
 * do cliente vira caminho: o nome é gerado pelo servidor. A conferência abaixo é a segunda trava.
 */
const KEY_PATTERN = new RegExp(`^${UUID}/${UUID}/${UUID}\\.(jpg|png|webp)$`);

export class DiskStorage implements FileStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private pathOf(key: string): string {
    if (!KEY_PATTERN.test(key)) throw new Error('chave de arquivo inválida');
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error('chave de arquivo inválida');
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const target = this.pathOf(key);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o750 });
    // Grava num nome temporário e renomeia: ninguém lê um arquivo pela metade.
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, data, { mode: 0o640, flag: 'wx' });
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathOf(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }
}

/** Guarda em memória, para os testes. */
export class MemoryStorage implements FileStorage {
  readonly files = new Map<string, Buffer>();

  put(key: string, data: Buffer): Promise<void> {
    this.files.set(key, data);
    return Promise.resolve();
  }

  get(key: string): Promise<Buffer | null> {
    return Promise.resolve(this.files.get(key) ?? null);
  }

  remove(key: string): Promise<void> {
    this.files.delete(key);
    return Promise.resolve();
  }
}

export interface ImageKind {
  ext: 'jpg' | 'png' | 'webp';
  contentType: string;
}

export const CONTENT_TYPE_BY_EXT: Record<ImageKind['ext'], string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Descobre o tipo pelos primeiros bytes. O `Content-Type` enviado pelo cliente não vale nada. */
export function sniffImage(data: Buffer): ImageKind | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return { ext: 'jpg', contentType: CONTENT_TYPE_BY_EXT.jpg };
  }
  if (data.length >= 8 && data.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { ext: 'png', contentType: CONTENT_TYPE_BY_EXT.png };
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('latin1') === 'RIFF' &&
    data.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return { ext: 'webp', contentType: CONTENT_TYPE_BY_EXT.webp };
  }
  return null;
}
