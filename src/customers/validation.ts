/** Validações de dados de cliente. Tudo é guardado só com dígitos (CPF, CEP e telefone). */

const onlyDigits = (value: string): string => value.replaceAll(/\D/g, '');

/**
 * Telefone do WhatsApp: só dígitos, com código do país. Com "+" vale o que foi digitado; sem ele,
 * número brasileiro com DDD (10 ou 11 dígitos) ganha o 55. Devolve `null` se não parecer um telefone.
 */
export function normalizePhone(value: string): string | null {
  const digits = onlyDigits(value);
  if (value.trim().startsWith('+'))
    return digits.length >= 8 && digits.length <= 15 ? digits : null;
  // Sem "+": número brasileiro com DDD (10 ou 11 dígitos, sem zero na frente) ganha o 55.
  const domestic = digits.length === 10 || digits.length === 11;
  if (domestic) return digits.startsWith('0') ? null : '55' + digits;
  return digits.length >= 12 && digits.length <= 15 && !digits.startsWith('0') ? digits : null;
}

function cpfDigit(digits: string, length: number): number {
  let sum = 0;
  for (let i = 0; i < length; i += 1) sum += Number(digits[i]) * (length + 1 - i);
  const rest = (sum * 10) % 11;
  return rest === 10 ? 0 : rest;
}

/** CPF válido (dígitos verificadores) → só dígitos; senão `null`. */
export function normalizeCpf(value: string): string | null {
  const digits = onlyDigits(value);
  if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return null;
  const valid =
    cpfDigit(digits, 9) === Number(digits[9]) && cpfDigit(digits, 10) === Number(digits[10]);
  return valid ? digits : null;
}

/** CEP com 8 dígitos → só dígitos; senão `null`. */
export function normalizeCep(value: string): string | null {
  const digits = onlyDigits(value);
  return digits.length === 8 ? digits : null;
}

/** `•••.•••.•••-45` a partir dos 2 últimos dígitos guardados (o CPF inteiro nunca sai da API). */
export function maskCpfLast2(last2: string | null): string | null {
  return last2 === null || !/^\d{2}$/.test(last2) ? null : `•••.•••.•••-${last2}`;
}

/** `•••.•••.•••-45`: o CPF inteiro nunca sai da API. */
export function maskCpf(cpf: string | null): string | null {
  const digits = cpf === null ? '' : onlyDigits(cpf);
  return digits.length < 2 ? null : `•••.•••.•••-${digits.slice(-2)}`;
}
