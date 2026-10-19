import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

/**
 * CPF cifrado em repouso (ADR 0019 do shared). O banco nunca guarda o CPF legível:
 *
 * - `cipher`: AES-256-GCM, no formato `v1.<iv>.<tag>.<texto>` (base64url). O prefixo `v1` deixa
 *   trocar o algoritmo depois.
 * - `last2`: os dois últimos dígitos, só para a máscara `•••.•••.•••-NN` (já aparece na tela).
 * - `keyHash`: HMAC-SHA256 dos 4 primeiros dígitos, a chave de acesso do consignador (ADR 0014). Sem
 *   a chave do servidor, as 10 mil combinações não se testam contra o valor guardado.
 *
 * As duas chaves saem de `CPF_ENCRYPTION_KEY` por HKDF, com rótulos diferentes.
 */
export interface SealedCpf {
  cipher: string;
  last2: string;
  keyHash: string;
}

const CIPHER_FORMAT = /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/;
const b64 = (data: Buffer): string => data.toString('base64url');

export class CpfVault {
  private readonly encryptionKey: Buffer;
  private readonly hashKey: Buffer;

  constructor(secret: string) {
    const derive = (label: string) =>
      Buffer.from(hkdfSync('sha256', secret, 'pokemon-auction', label, 32));
    this.encryptionKey = derive('cpf-aes-256-gcm');
    this.hashKey = derive('cpf-key-hmac');
  }

  /**
   * Cifra um CPF já validado (11 dígitos). O `iv` vem sorteado; só o seed de desenvolvimento o
   * fixa, para o banco de teste ser idêntico a cada execução. Nunca reutilize `iv` em dado real.
   */
  seal(cpf: string, iv: Buffer = randomBytes(12)): SealedCpf {
    if (!/^\d{11}$/.test(cpf)) throw new Error('o CPF a cifrar precisa ter 11 dígitos');
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const text = Buffer.concat([cipher.update(cpf, 'utf8'), cipher.final()]);
    return {
      cipher: `v1.${b64(iv)}.${b64(cipher.getAuthTag())}.${b64(text)}`,
      last2: cpf.slice(-2),
      keyHash: this.keyHash(cpf.slice(0, 4)),
    };
  }

  /** HMAC (hex) dos 4 primeiros dígitos: o que a função pública compara no banco. */
  keyHash(firstFour: string): string {
    return createHmac('sha256', this.hashKey).update(firstFour).digest('hex');
  }

  /** Decifra. Lança se o valor foi adulterado ou a chave é outra. */
  open(sealed: string): string {
    if (!CIPHER_FORMAT.test(sealed)) throw new Error('CPF fora do formato cifrado');
    const [, iv, tag, text] = sealed.split('.') as [string, string, string, string];
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.encryptionKey,
      Buffer.from(iv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(text, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}

/** O valor guardado já está cifrado (e não é um CPF legível de antes da migration 0024)? */
export const isSealed = (value: string): boolean => CIPHER_FORMAT.test(value);
