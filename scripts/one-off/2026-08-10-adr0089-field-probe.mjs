#!/usr/bin/env node
// ADR-0089 field-proof probe (2026-08-10, read-only, run once).
//
// Question: does MyMRC actually POPULATE Recycler_Reported_Delivery_Date__c
// (and the fallback candidates) on Delivered hauls — especially the undated
// collection-network hauls the inbound bridge currently drops?
//
// READ-ONLY by construction: this drives the same batched getRecordWithFields
// transport as the enrichment engine but never calls enrichDetails/upsert —
// no mirror row, ledger row, or business table is written. The only writes are
// the credential-store session snapshot (normal for every hourly run).
//
// Sample: 14 hauls in 5 classes —
//   A canonical undated Delivered (H-137017, Golden Bear)
//   B 6 post-anchor undated Delivered across vendors (Ikea/Recology/Solano/Vasco)
//   C 3 dated Delivered comparators (dock 08-10..08-12)
//   D 2 Confirmed future (negative control — expect null delivery date)
//   E 2 pre-anchor undated Delivered (H-065158, H-000585 — D4 backfill matters)

import { chromium } from 'playwright';
import { PrismaClient } from '@prisma/client';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mymrc = require('/app/dist/mymrc');

const SAMPLE = [
  ['A', 'a2KUJ00000Gq5IX2AZ', 'H-137017'],
  ['B', 'a2KUJ00000GnUIH2A3', 'H-136896'],
  ['B', 'a2KUJ00000GnfYf2AJ', 'H-136905'],
  ['B', 'a2KUJ00000GmqBB2AZ', 'H-136855'],
  ['B', 'a2KUJ00000GlXnJ2AV', 'H-136738'],
  ['B', 'a2KUJ00000GlYLB2A3', 'H-136741'],
  ['B', 'a2KUJ00000GlXyb2AF', 'H-136739'],
  ['C', 'a2KUJ00000GjLa92AF', 'H-136583'],
  ['C', 'a2KUJ00000GfcPt2AJ', 'H-136271'],
  ['C', 'a2KUJ00000GkwpN2AR', 'H-136699'],
  ['D', 'a2KUJ00000GnmOr2AJ', 'H-136912'],
  ['D', 'a2KUJ00000GnZ3R2AV', 'H-136900'],
  ['E', 'a2KUJ000006X6yw2AC', 'H-065158'],
  ['E', 'a2KUJ000001KAtt2AG', 'H-000585'],
];

const PROBE_FIELDS = [
  'Haul_Request__c.Name',
  'Haul_Request__c.Status__c',
  'Haul_Request__c.Collection_Source__c',
  'Haul_Request__c.Collection_Site__c',
  'Haul_Request__c.Docking_Appointment_Date__c',
  'Haul_Request__c.Recycler_Reported_Delivery_Date__c',
  'Haul_Request__c.Transporter_Reported_Delivery_Date__c',
  'Haul_Request__c.Actual_Pickup_Date__c',
  'Haul_Request__c.Unit_Count_at_Unload__c',
  'Haul_Request__c.Recycler_Reported_Arrival_Time__c',
  'Haul_Request__c.Recycler_Reported_Departure_Time__c',
  'Haul_Request__c.Transporter_Reported_Arrival_Time__c',
  'Haul_Request__c.CreatedDate',
  'Haul_Request__c.LastModifiedDate',
];

function log(level, message) {
  const line = `field-probe[${new Date().toISOString()}]: ${message}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

function fieldValue(record, qualified) {
  const short = qualified.replace(/^Haul_Request__c\./, '');
  const f = record.fields[short];
  if (f === undefined) return '<ABSENT>'; // FLS-hidden or not on the record
  const v = f && typeof f === 'object' && 'value' in f ? f.value : f;
  if (v === null) return null;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

async function main() {
  const prisma = new PrismaClient();
  const browser = await chromium.launch({ headless: true });
  try {
    const creds = await mymrc.loadAdminCredentials(prisma);
    const session = await mymrc.openAdminSession(browser, creds, { log });
    try {
      const client = mymrc.createRecordFieldsClient(
        mymrc.playwrightRecordFieldsSession(session, log),
        { log },
      );
      const ids = SAMPLE.map(([, id]) => id);
      const { records, errors } = await client.fetchRecordFields(ids, PROBE_FIELDS);
      log('info', `fetched ${records.size}/${ids.length} records, ${errors.length} errors`);
      for (const e of errors) log('warn', `ERROR ${e.recordId}: ${e.state} ${e.message}`);

      const out = [];
      for (const [cls, id, haul] of SAMPLE) {
        const rec = records.get(id);
        if (!rec) {
          out.push({ class: cls, haul, error: 'no record returned' });
          continue;
        }
        const row = { class: cls, haul };
        for (const q of PROBE_FIELDS) {
          const short = q
            .replace(/^Haul_Request__c\./, '')
            .replace(/__c$/, '')
            .replace(/_/g, ' ');
          row[short] = fieldValue(rec, q);
        }
        out.push(row);
      }
      console.log('=== PROBE RESULT JSON ===');
      console.log(JSON.stringify(out, null, 2));
      console.log('=== END PROBE RESULT ===');
    } finally {
      await session.close().catch(() => undefined);
    }
  } finally {
    await browser.close().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  }
}

main().catch((err) => {
  log('error', `fatal: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
