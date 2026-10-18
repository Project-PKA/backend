/**
 * Extrai do código todos os `code` de erro que a API pode devolver em `application/problem+json`
 * (RFC 9457) e grava `docs/api/error-codes.json`. O frontend traduz pelo `code` (ADR 0017), então
 * este arquivo é o contrato de tradução: um `code` novo sem entrada aqui falha no teste.
 *
 *   npm run error-codes:generate
 *
 * A extração lê a árvore sintática (TypeScript) de `src/` e entende estas formas:
 *  - `buildProblem(status, detail, 'CODE')`
 *  - `buildProblem(status, detail, \`PREFIXO_${motivo}\`)`, expandido com as chaves do mapa
 *    `Record<Motivo, [status, texto]>` usado na mesma função
 *  - `[status, texto, 'CODE']` (tuplas de mapas de erro)
 *  - funções auxiliares que recebem o código (`forbidden(reply, 'CODE')`, `invalidData(reply, 'CODE', ...)`)
 *  - o parâmetro padrão `code = 'FORBIDDEN'`
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

export interface ErrorCode {
  code: string;
  /** Status HTTP quando o código sempre vem com o mesmo; `null` se for variável. */
  status: number | null;
}

const CODE_PATTERN = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/;

/** Códigos gerados pelo framework (`src/http/problem.ts`, `codeFor`), sem chamada a `buildProblem`. */
const FRAMEWORK: ErrorCode[] = [
  { code: 'RATE_LIMITED', status: 429 },
  { code: 'VALIDATION_ERROR', status: 400 },
];

/** Função auxiliar -> posição do argumento que é o código. */
const HELPERS: Record<string, number> = { forbidden: 1, invalidData: 1 };

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return listFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

const numberOf = (node: ts.Node | undefined): number | null =>
  node !== undefined && ts.isNumericLiteral(node) ? Number(node.text) : null;

const stringOf = (node: ts.Node | undefined): string | null =>
  node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;

/** Entradas `CHAVE: [status, ...]` de um objeto literal: chave -> status. */
function statusEntries(object: ts.ObjectLiteralExpression): Map<string, number | null> {
  const entries = new Map<string, number | null>();
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isArrayLiteralExpression(property.initializer)) {
      continue;
    }
    const status = numberOf(property.initializer.elements[0]);
    const key = ts.isIdentifier(property.name) ? property.name.text : stringOf(property.name);
    if (status !== null && key !== null) entries.set(key, status);
  }
  return entries;
}

/** Mapas `const X = { CHAVE: [status, ...] }` do arquivo: nome -> chave -> status. */
function statusMaps(file: ts.SourceFile): Map<string, Map<string, number | null>> {
  const maps = new Map<string, Map<string, number | null>>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      const entries = statusEntries(node.initializer);
      if (entries.size > 0) maps.set(node.name.text, entries);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return maps;
}

function enclosingFunction(node: ts.Node): ts.Node {
  let current: ts.Node = node;
  for (;;) {
    const parent = current.parent as ts.Node | undefined;
    if (parent === undefined) return node;
    if (ts.isFunctionLike(parent) || ts.isSourceFile(parent)) return parent;
    current = parent;
  }
}

type Found = Map<string, number | null>;
type StatusMaps = Map<string, Map<string, number | null>>;

function record(found: Found, code: string | null, status: number | null): void {
  if (code === null || !CODE_PATTERN.test(code)) return;
  const previous = found.get(code);
  found.set(code, previous === undefined || previous === status ? status : null);
}

/** Nomes dos mapas `{ CHAVE: [status, ...] }` consultados (`MAPA[motivo]`) dentro de `scope`. */
function mapsUsedIn(scope: ts.Node, maps: StatusMaps): Set<string> {
  const used = new Set<string>();
  const scan = (node: ts.Node): void => {
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      maps.has(node.expression.text)
    ) {
      used.add(node.expression.text);
    }
    ts.forEachChild(node, scan);
  };
  scan(scope);
  return used;
}

/** `PREFIXO_${motivo}`: um código por chave do mapa usado na mesma função. */
function expandTemplate(
  call: ts.CallExpression,
  template: ts.TemplateExpression,
  maps: StatusMaps,
  found: Found,
): void {
  const [span] = template.templateSpans;
  if (template.templateSpans.length !== 1 || span === undefined) return;
  for (const name of mapsUsedIn(enclosingFunction(call), maps)) {
    for (const [key, status] of maps.get(name) ?? []) {
      record(found, template.head.text + key + span.literal.text, status);
    }
  }
}

function visitCall(call: ts.CallExpression, maps: StatusMaps, found: Found): void {
  if (!ts.isIdentifier(call.expression)) return;
  const callee = call.expression.text;
  if (callee === 'buildProblem') {
    const third = call.arguments[2];
    if (third !== undefined && ts.isTemplateExpression(third)) {
      expandTemplate(call, third, maps, found);
    } else {
      record(found, stringOf(third), numberOf(call.arguments[0]));
    }
  } else if (callee in HELPERS) {
    record(found, stringOf(call.arguments[HELPERS[callee] ?? -1]), null);
  }
}

/** Tupla `[status, texto, 'CODIGO']` de mapa de erros. */
function visitTuple(array: ts.ArrayLiteralExpression, found: Found): void {
  if (array.elements.length !== 3) return;
  const [status, , code] = array.elements;
  const number = numberOf(status);
  if (number !== null && number >= 400) record(found, stringOf(code), number);
}

/** Parâmetro padrão `code = 'FORBIDDEN'`. */
function visitParameter(parameter: ts.ParameterDeclaration, found: Found): void {
  if (ts.isIdentifier(parameter.name) && parameter.name.text === 'code') {
    record(found, stringOf(parameter.initializer), null);
  }
}

function extractFromFile(file: ts.SourceFile, found: Found): void {
  const maps = statusMaps(file);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) visitCall(node, maps, found);
    else if (ts.isArrayLiteralExpression(node)) visitTuple(node, found);
    else if (ts.isParameter(node)) visitParameter(node, found);
    ts.forEachChild(node, visit);
  };
  visit(file);
}

export function extractErrorCodes(root = '.'): ErrorCode[] {
  const found = new Map<string, number | null>();
  for (const entry of FRAMEWORK) found.set(entry.code, entry.status);
  for (const fileName of listFiles(path.join(root, 'src'))) {
    const source = ts.createSourceFile(
      fileName,
      readFileSync(fileName, 'utf-8'),
      ts.ScriptTarget.Latest,
      true,
    );
    extractFromFile(source, found);
  }
  return [...found.entries()]
    .map(([code, status]) => ({ code, status }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

export const ERROR_CODES_FILE = 'docs/api/error-codes.json';

export const renderErrorCodes = (codes: ErrorCode[]): string =>
  JSON.stringify({ codes }, null, 2) + '\n';

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const codes = extractErrorCodes();
  writeFileSync(ERROR_CODES_FILE, renderErrorCodes(codes), 'utf-8');
  console.log(`${String(codes.length)} códigos de erro gravados em ${ERROR_CODES_FILE}`);
}
