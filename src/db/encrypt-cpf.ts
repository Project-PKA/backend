import { runEncryptCpf } from './encrypt-legacy-cpf.js';

// Cifra os CPFs ainda legíveis no banco (clientes anteriores à migration 0024). Roda com o dono do
// schema e a mesma `CPF_ENCRYPTION_KEY` da API. A lógica está em `encrypt-legacy-cpf.ts`.
console.log(await runEncryptCpf(process.env));
