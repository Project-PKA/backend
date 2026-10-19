import { SEED_CPF_KEY } from '../../src/db/seed.js';
import { CpfVault } from '../../src/security/cpf-vault.js';

/** Mesma chave do ambiente de teste (`testEnv`): serve para conferir o que a API gravou. */
export const cpfVault = new CpfVault(SEED_CPF_KEY);

/** CPF legível a partir do valor cifrado do banco; `null` quando não há CPF. */
export const openCpf = (stored: string | null | undefined): string | null =>
  stored === null || stored === undefined ? null : cpfVault.open(stored);
