import { CpfKeyError, runRotateCpfKey } from './cpf-key-rotation.js';

// Rotaciona a chave do CPF (ou, com --check, só confere). Roda com o dono do schema. A lógica e as
// instruções estão em `cpf-key-rotation.ts` e em `docs/secrets.md`.
try {
  const { message, exitCode } = await runRotateCpfKey(process.env, process.argv.slice(2));
  console.log(message);
  process.exitCode = exitCode;
} catch (error) {
  console.error(error instanceof CpfKeyError ? error.message : 'Falha na rotação da chave do CPF');
  process.exitCode = 1;
}
