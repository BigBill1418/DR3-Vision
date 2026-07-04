// ADR-0041 D4/D5 — xlsx render of an invoice's Summary tab.
//
// Reproduces the workbook Summary structure (mission §3.1 / §4 — "generated,
// never hand-entered") for the processing + transportation kinds. The COMMODITY
// blocks are EXCLUDED (D5: the daily-log-9 → billing-11 mapping is still pending
// Kelsey/Janette, B10-5) — the invoice set does not need them; they join the
// workbook-export surface when the mapping lands.
//
// The Summary MODEL (`buildInvoiceSummaryModel`) is a PURE structure so a fixture
// test can assert it against the §3.1 line map without serializing a workbook.
// `renderInvoiceXlsxBuffer` is the exceljs binding the download route calls.

import ExcelJS from 'exceljs';
import type { InvoiceView } from './view';
import type { InvoiceKind, InvoiceStatus } from './types';
import { LINE_CODE } from './types';

const KIND_LABEL: Record<InvoiceKind, string> = {
  ca_processing_mid_month: 'CA Processing — Mid-Month',
  ca_processing_eom: 'CA Processing — End of Month',
  ca_transportation_eom: 'CA Transportation — End of Month',
  or_processing_eom: 'OR Processing — End of Month',
  or_transportation_eom: 'OR Transportation — End of Month',
  or_collection_site_count: 'OR Collection-Site Count',
};

export interface SummaryRow {
  code: string;
  label: string;
  quantity: string | null;
  amountCents: number;
  kind: 'line' | 'subtotal' | 'total';
}

export interface InvoiceSummaryModel {
  title: string;
  kind: InvoiceKind;
  kindLabel: string;
  siteId: string;
  billingMonthISO: string;
  windowStartISO: string;
  windowEndISO: string;
  version: number;
  status: InvoiceStatus;
  rows: SummaryRow[];
  totalCents: number;
}

function dayISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Build the pure Summary model. For the CA EOM processing invoice a derived B15
 * subtotal is inserted before the B22 offset (B15 = Σ positive leaves; B22 =
 * B15 − B20 = the total) so the "honest offset" reads exactly as the §3.1 map.
 */
export function buildInvoiceSummaryModel(inv: InvoiceView): InvoiceSummaryModel {
  const rows: SummaryRow[] = [];
  const isCaEomProcessing = inv.kind === 'ca_processing_eom';
  const offsetIdx = inv.lines.findIndex((l) => l.lineCode === LINE_CODE.eomOffset);

  inv.lines.forEach((l, i) => {
    // Insert the B15 subtotal (Σ leaves) immediately before the offset line.
    if (isCaEomProcessing && offsetIdx >= 0 && i === offsetIdx) {
      const b15 = inv.lines
        .filter((x) => x.lineCode !== LINE_CODE.eomOffset)
        .reduce((acc, x) => acc + x.amountCents, 0);
      rows.push({ code: 'B15', label: 'Processing subtotal (B6 + B7 + B8)', quantity: null, amountCents: b15, kind: 'subtotal' });
    }
    rows.push({ code: l.lineCode, label: l.description, quantity: l.quantity, amountCents: l.amountCents, kind: 'line' });
  });

  rows.push({ code: 'TOTAL', label: 'Invoice total', quantity: null, amountCents: inv.totalCents, kind: 'total' });

  return {
    title: 'DR3 — MRC Invoice (Summary)',
    kind: inv.kind,
    kindLabel: KIND_LABEL[inv.kind],
    siteId: inv.siteId,
    billingMonthISO: dayISO(inv.billingMonth),
    windowStartISO: dayISO(inv.windowStart),
    windowEndISO: dayISO(inv.windowEnd),
    version: inv.version,
    status: inv.status,
    rows,
    totalCents: inv.totalCents,
  };
}

/** Render an invoice to an xlsx Summary workbook (exceljs). */
export async function renderInvoiceXlsxBuffer(inv: InvoiceView): Promise<Buffer> {
  const model = buildInvoiceSummaryModel(inv);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'DR3-Vision';
  wb.created = new Date();
  const ws = wb.addWorksheet('Summary');

  ws.columns = [
    { key: 'code', width: 14 },
    { key: 'label', width: 52 },
    { key: 'qty', width: 12 },
    { key: 'amount', width: 16 },
  ];

  ws.addRow([model.title]);
  ws.addRow([model.kindLabel]);
  ws.addRow(['Site', model.siteId]);
  ws.addRow(['Billing month', model.billingMonthISO]);
  ws.addRow(['Window', `${model.windowStartISO} .. ${model.windowEndISO}`]);
  ws.addRow(['Version', model.version, 'Status', model.status]);
  ws.addRow([]);
  const headerRow = ws.addRow(['Line', 'Description', 'Qty', 'Amount (USD)']);
  headerRow.font = { bold: true };

  for (const r of model.rows) {
    const row = ws.addRow([r.code, r.label, r.quantity ?? '', r.amountCents / 100]);
    const amountCell = row.getCell(4);
    amountCell.numFmt = '#,##0.00;(#,##0.00)'; // negatives (offset) in parentheses
    if (r.kind === 'subtotal' || r.kind === 'total') row.font = { bold: true };
  }

  const arr = await wb.xlsx.writeBuffer();
  return Buffer.from(arr);
}
