#!/usr/bin/env node
// ADR-0115 — static gate for the F-5 class: a key in a Prisma write payload
// that the model does not have.
//
// The class, concretely: `workbook-promotion.ts` passed `source: 'import'` to
// `inboundLoad.createMany`. `InboundLoad.source` is the `Source?` RELATION, not
// a scalar, so it is not a member of `InboundLoadCreateManyInput`. Prisma
// rejects that at ARGUMENT VALIDATION — before the query is sent — which aborts
// the enclosing `$transaction`. Every promoted row silently failed to land for
// six weeks (2026-07-06 → 2026-08-19).
//
// Why a bespoke gate rather than the type-checker: `tsc --noEmit` exits 0 on it.
// Prisma's `SelectSubset<T, S>` maps only the top-level argument keys (`data`,
// `skipDuplicates`), and lets `T['data']` through unmapped — so excess-property
// ("freshness") checking is gone by the time the nested payload is compared.
// The bug is invisible to the compiler and invisible to any test that injects a
// hand-rolled fake client, which is what both promotion suites did.
//
// Reads the model field sets from the GENERATED client (`.prisma/client`), so
// the gate tracks `schema.prisma` automatically and cannot drift from it.
//
// Usage:  node scripts/check-prisma-write-keys.mjs
// Exit 0 = no invalid keys. Exit 1 = at least one invalid key, or the gate
// could not establish its own preconditions (see "blind" below).

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import ts from 'typescript';

const REPO = process.cwd();
const DTS = path.join(REPO, 'node_modules/.prisma/client/index.d.ts');

// ── 1. The allowed key sets, read from the generated client ────────────────
//
// PER METHOD, not unioned across methods. This distinction is the whole gate:
// `InboundLoadCreateInput` DOES have a `source` key (the relation-connect form,
// `SourceCreateNestedOneWithoutInbound_loadsInput`) while
// `InboundLoadCreateManyInput` does NOT — `createMany` cannot write relations,
// only scalars. A union of the two would have declared the F-5 payload legal and
// this script would have reported a clean tree over the live defect.
if (!existsSync(DTS)) {
  console.error(
    `[prisma-write-keys] BLIND: generated client not found at ${DTS}.\n` +
      `  Run \`npx prisma generate\` first. Refusing to report a clean result ` +
      `without the field sets to check against.`,
  );
  process.exit(1);
}
const dts = readFileSync(DTS, 'utf8');

/** `<Model><Suffix>Input` -> Set of its keys. */
const inputTypes = new Map();
const INPUT_RE = /export type (\w+Input) = \{([\s\S]*?)\n {2}\}/g;
for (const m of dts.matchAll(INPUT_RE)) {
  const set = new Set();
  for (const line of m[2].split('\n')) {
    const k = line.match(/^\s{4}(\w+)\??:/);
    if (k) set.add(k[1]);
  }
  inputTypes.set(m[1], set);
}

/** Which generated input types each write method's payload is checked against. */
const SUFFIXES = {
  create: ['CreateInput', 'UncheckedCreateInput'],
  createMany: ['CreateManyInput'],
  update: ['UpdateInput', 'UncheckedUpdateInput'],
  updateMany: ['UpdateManyMutationInput', 'UncheckedUpdateManyInput'],
  // upsert nests both; resolved per-carrier below.
  upsertCreate: ['CreateInput', 'UncheckedCreateInput'],
  upsertUpdate: ['UpdateInput', 'UncheckedUpdateInput'],
};

/** Models are every name with a CreateManyInput — the canonical model marker. */
const models = new Set();
for (const t of inputTypes.keys()) {
  const m = t.match(/^(\w+)CreateManyInput$/);
  if (m) models.add(m[1]);
}
if (models.size === 0) {
  console.error(
    '[prisma-write-keys] BLIND: parsed 0 models out of the generated client. ' +
      'The generator layout changed — fix this script rather than trusting its silence.',
  );
  process.exit(1);
}

/** Union of the input-type key sets a given (model, method) accepts, or null. */
function allowedKeys(model, kind) {
  const set = new Set();
  let found = false;
  for (const suffix of SUFFIXES[kind]) {
    const t = inputTypes.get(`${model}${suffix}`);
    if (t) {
      found = true;
      for (const k of t) set.add(k);
    }
  }
  return found ? set : null;
}

// Prisma's client accessor is the model name lower-camel-cased.
const modelByAccessor = new Map();
for (const model of models) {
  modelByAccessor.set(model[0].toLowerCase() + model.slice(1), model);
}

// ── 2. Walk the source for write calls ─────────────────────────────────────
const WRITE_METHODS = new Set(['create', 'createMany', 'update', 'updateMany', 'upsert']);

const files = execFileSync('git', ['ls-files', 'src/**/*.ts', 'src/**/*.tsx', 'scripts/**/*.ts'], {
  cwd: REPO,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean)
  .filter((f) => !/\.test\.tsx?$/.test(f) && !/__testutils__|__mocks__/.test(f));

const violations = [];
let checked = 0;
let skipped = 0;

/** Top-level keys of an object literal, or null if it is not statically readable. */
function literalKeys(node) {
  if (!ts.isObjectLiteralExpression(node)) return null;
  const keys = [];
  for (const p of node.properties) {
    // A spread makes the key set open — we cannot prove absence, so bail.
    if (ts.isSpreadAssignment(p)) return null;
    const n = p.name;
    if (!n) return null;
    if (ts.isIdentifier(n) || ts.isStringLiteral(n)) keys.push(n.text);
    else return null; // computed key
  }
  return keys;
}

/** Unwraps `[{...}]`, `xs.map(x => ({...}))`, `xs.map(function(){ return {...} })`. */
function payloadLiterals(node) {
  if (ts.isObjectLiteralExpression(node)) return [node];
  if (ts.isArrayLiteralExpression(node)) {
    const out = [];
    for (const el of node.elements) {
      if (ts.isObjectLiteralExpression(el)) out.push(el);
      else return null;
    }
    return out;
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'map' &&
    node.arguments.length > 0
  ) {
    const fn = node.arguments[0];
    if (ts.isArrowFunction(fn)) {
      let body = fn.body;
      while (ts.isParenthesizedExpression(body)) body = body.expression;
      if (ts.isObjectLiteralExpression(body)) return [body];
    }
    return null;
  }
  return null;
}

for (const rel of files) {
  const abs = path.join(REPO, rel);
  const src = ts.createSourceFile(
    rel,
    readFileSync(abs, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    /\.tsx$/.test(rel) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      WRITE_METHODS.has(node.expression.name.text) &&
      ts.isPropertyAccessExpression(node.expression.expression)
    ) {
      const method = node.expression.name.text;
      const accessor = node.expression.expression.name.text;
      const model = modelByAccessor.get(accessor);
      const arg = node.arguments[0];
      if (model && arg && ts.isObjectLiteralExpression(arg)) {
        // `upsert` nests its payloads under `create`/`update`; every other
        // method carries a single `data`. The carrier NAME picks the input
        // type, so an upsert's two halves are checked against different sets.
        for (const p of arg.properties) {
          if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
          const carrier = p.name.text;
          let kind;
          if (carrier === 'data') kind = method;
          else if (method === 'upsert' && carrier === 'create') kind = 'upsertCreate';
          else if (method === 'upsert' && carrier === 'update') kind = 'upsertUpdate';
          else continue;

          const allowed = allowedKeys(model, kind);
          if (!allowed) {
            skipped++;
            continue;
          }
          const lits = payloadLiterals(p.initializer);
          if (!lits) {
            skipped++;
            continue;
          }
          for (const lit of lits) {
            const keys = literalKeys(lit);
            if (!keys) {
              skipped++;
              continue;
            }
            checked++;
            for (const k of keys) {
              if (!allowed.has(k)) {
                const { line } = src.getLineAndCharacterOfPosition(lit.getStart(src));
                violations.push({ file: rel, line: line + 1, model, accessor, method, key: k });
              }
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
}

// ── 3. Report ──────────────────────────────────────────────────────────────
// The skipped count is printed ALWAYS. A gate that reports "clean" without
// saying how much it could not read is indistinguishable from a gate that is
// switched off.
console.log(
  `[prisma-write-keys] models ${models.size} · files ${files.length} · ` +
    `payloads checked ${checked} · payloads not statically readable ${skipped}`,
);

if (violations.length > 0) {
  console.error(`\n[prisma-write-keys] ${violations.length} invalid key(s):\n`);
  for (const v of violations) {
    console.error(
      `  ${v.file}:${v.line}  ${v.accessor}.${v.method}() payload has key ` +
        `\`${v.key}\`, which ${v.model} does not accept for that method`,
    );
  }
  console.error(
    '\nPrisma rejects an unknown argument at validation time, before the query is ' +
      'sent — inside a $transaction that aborts every sibling write with it.\n',
  );
  process.exit(1);
}

console.log('[prisma-write-keys] OK — no invalid keys in any statically-readable write payload.');
