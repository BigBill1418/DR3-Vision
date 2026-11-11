#!/usr/bin/env node
// Browser GlitchTip DSN bake check (ADR-0022 Amendment 1). No network.
//
// Next.js inlines NEXT_PUBLIC_* into the browser chunks at BUILD time, so the
// only proof that the floor tablets can report errors is the built output itself.
// Run after `next build`:
//
//   node scripts/check-browser-dsn.mjs --expect errors.barnardhq.com   # DSN build
//   node scripts/check-browser-dsn.mjs --expect-none                   # no-DSN build
//
// Both modes also FAIL if the WireGuard-private ingest host (glitchtip.barnardhq.com,
// unreachable from the tablets) appears in any browser chunk.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PRIVATE_HOST = 'glitchtip.barnardhq.com';
// A Sentry DSN baked as a string literal: https://<key>@<host>/<project>.
const DSN_LITERAL = /https:\/\/[0-9a-zA-Z]+@[a-z0-9.-]+\/\d+/;

const args = process.argv.slice(2);
const staticDir = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : '.next/static';
const expectHost = args.includes('--expect') ? args[args.indexOf('--expect') + 1] : null;
const expectNone = args.includes('--expect-none');
if (Boolean(expectHost) === expectNone) {
  console.error(
    'usage: check-browser-dsn.mjs (--expect <host> | --expect-none) [--dir .next/static]',
  );
  process.exit(2);
}

function* jsFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* jsFiles(p);
    else if (name.endsWith('.js')) yield p;
  }
}

let files = 0;
const dsnHits = [];
const privateHits = [];
for (const file of jsFiles(staticDir)) {
  files += 1;
  const src = readFileSync(file, 'utf8');
  const m = src.match(DSN_LITERAL);
  if (m) dsnHits.push({ file, dsn: m[0] });
  if (src.includes(PRIVATE_HOST)) privateHits.push(file);
}

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};
if (files === 0) fail(`no .js files under ${staticDir} — run next build first`);
if (privateHits.length) fail(`WG-private ${PRIVATE_HOST} baked into: ${privateHits.join(', ')}`);
if (expectNone && dsnHits.length) fail(`DSN baked without one configured: ${dsnHits[0].file}`);
if (expectHost) {
  const ok = dsnHits.filter((h) => new URL(h.dsn).host === expectHost);
  if (!ok.length) fail(`no DSN for ${expectHost} in ${files} browser chunks`);
  console.log(`OK: DSN host ${expectHost} baked into ${ok.length} chunk(s) of ${files}`);
} else {
  console.log(`OK: no DSN in ${files} browser chunks`);
}
