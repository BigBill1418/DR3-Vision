#!/usr/bin/env node
// Eager historical-PDF generation (ADR-0023 Q13 / T-321).
//
// For every `bonus_pay_periods` row in state `historical_imported` with a NULL
// `pdf_storage_key`, render + upload its PDF and stamp the storage key. The PDF
// uses the AS-PAID legacy total (ADR-0023 Q1: when imported_with_legacy_formula
// is set the figure comes from legacy_total_payout_cents) and an import-specific
// attestation naming the source workbook + SHA-256 ("not signed by facility or
// ops") — both produced by the historical-aware internal render page.
//
// RUNTIME-IMPORT STRATEGY (the ".mjs can't import TS" question): this wrapper
// stays plain JavaScript and does NOT import the TypeScript PDF/R2 code. It
// follows the established fleet convention (see scripts/bonus-period-close.mjs
// →/api/internal/bonus/close-months): the orchestration — Playwright render +
// R2 upload + pdf_storage_key persist, all in @/lib/bonus/pdf — lives behind a
// loopback-guarded internal Next route (/api/internal/bonus/generate-pdf/<id>),
// and this script just (a) enumerates the eligible periods via Prisma (same
// access path the seed uses) and (b) POSTs each id to that route. The seed runs
// under bare `node` (prisma.seed = "node prisma/seed.mjs", no tsx loader), so a
// direct TS import is impossible anyway; the HTTP-to-internal-route pattern is
// the repo-consistent way to reuse the real generation code at seed/deploy time.
//
// IDEMPOTENT: periods that already carry a pdf_storage_key are skipped (the
// route also re-checks), so a re-run / re-deploy is a no-op. Logs a summary
// (generated N, skipped M, failed K).
//
// R2 / app-UNAVAILABLE tolerance: if the internal route is unreachable (app not
// running) or R2 is unconfigured (the route returns 500 "R2 not configured"),
// each period is counted as failed and logged, but the script does NOT throw on
// a per-period failure — it processes the rest and reports the tally. The seed
// caller (prisma/seed.mjs) invokes this best-effort and never lets a missing
// app / R2 hard-fail the whole seed; the operator runbook re-runs it standalone
// (`node scripts/generate-historical-pdfs.mjs`) once the app + R2 are up.

import { PrismaClient } from '@prisma/client';

const BASE = process.env.INTERNAL_BASE_URL ?? 'http://127.0.0.1:3000';
const TOKEN = process.env.INTERNAL_CRON_TOKEN ?? '';
const PER_PERIOD_TIMEOUT_MS = 60_000; // Playwright render + R2 upload headroom.

function logTs(message) {
  console.log(`[generate-historical-pdfs ${new Date().toISOString()}] ${message}`);
}

/**
 * Drive PDF generation for one period via the loopback-guarded internal route.
 * Resolves to { skipped } on a 2xx (skipped:true when the route found an
 * existing pdf_storage_key); throws on transport error or non-2xx so the caller
 * can tally it as a failure without aborting the batch.
 */
async function generateOne(periodId) {
  const headers = { 'content-type': 'application/json' };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_PERIOD_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${BASE}/api/internal/bonus/generate-pdf/${encodeURIComponent(periodId)}`,
      { method: 'POST', headers, signal: controller.signal },
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    let body = {};
    try {
      body = JSON.parse(text);
    } catch {
      // Non-JSON 2xx is unexpected but not fatal — treat as generated.
    }
    return { skipped: Boolean(body.skipped), storageKey: body.storageKey ?? null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Generate PDFs for every historical_imported period lacking a pdf_storage_key.
 * Idempotent; returns the run summary. Accepts an injected PrismaClient so the
 * seed can share its connection, or creates + disconnects its own when run
 * standalone.
 */
export async function generateHistoricalPdfs(injectedPrisma) {
  const prisma = injectedPrisma ?? new PrismaClient();
  const ownsClient = !injectedPrisma;
  const summary = { eligible: 0, generated: 0, skipped: 0, failed: 0 };

  try {
    // Eligibility: historical_imported AND no PDF yet (idempotency at the source).
    const periods = await prisma.bonusPayPeriod.findMany({
      where: { state: 'historical_imported', pdf_storage_key: null },
      select: { id: true, period_year: true, period_number: true, site_id: true },
      orderBy: [{ period_year: 'asc' }, { period_number: 'asc' }],
    });
    summary.eligible = periods.length;

    if (periods.length === 0) {
      logTs('no historical_imported periods need a PDF (all have pdf_storage_key) — no-op');
      return summary;
    }

    logTs(`${periods.length} historical_imported period(s) need a PDF; generating via ${BASE}`);

    for (const p of periods) {
      try {
        const { skipped, storageKey } = await generateOne(p.id);
        if (skipped) {
          summary.skipped++;
          logTs(`  skipped ${p.id} (already had pdf_storage_key=${storageKey ?? '?'})`);
        } else {
          summary.generated++;
          logTs(`  generated ${p.id} → ${storageKey ?? '(key not reported)'}`);
        }
      } catch (err) {
        summary.failed++;
        logTs(`  FAILED ${p.id}: ${err?.message ?? err}`);
      }
    }

    logTs(
      `done — eligible ${summary.eligible}, generated ${summary.generated}, ` +
        `skipped ${summary.skipped}, failed ${summary.failed}`,
    );
    return summary;
  } finally {
    if (ownsClient) await prisma.$disconnect();
  }
}

// Standalone entrypoint (operator runbook: `node scripts/generate-historical-pdfs.mjs`).
// A non-zero failure count exits non-zero so a CI/runbook caller notices, but a
// clean all-skipped/all-generated run exits 0. When imported by the seed this
// block does not run (the seed calls generateHistoricalPdfs() directly).
const isEntrypoint =
  process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (isEntrypoint) {
  generateHistoricalPdfs()
    .then((summary) => {
      process.exit(summary.failed > 0 ? 1 : 0);
    })
    .catch((err) => {
      logTs(`fatal: ${err?.message ?? err}`);
      process.exit(1);
    });
}
