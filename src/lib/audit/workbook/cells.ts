// Shared exceljs cell coercion for the audit workbook stack (ADR-0039 parser,
// ADR-0048/0049 section resolver). ONE implementation so a formula/date/
// shared-string cell reads identically wherever it is touched — a coercion fix
// that landed in only one copy would let the same cell parse in one module and
// misread in another (a silent audit-number divergence).
//
// (src/lib/workbook-sync/daily-adapter.ts carries its own copy by design: it is
// the ADR-0049 D12 parser-finalization seam, rewritten wholesale when the real
// file lands — it converges on this module then.)

import type ExcelJS from 'exceljs';

export function cellText(value: ExcelJS.CellValue): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'object' && 'result' in value && value.result !== undefined) {
    return cellText(value.result as ExcelJS.CellValue);
  }
  if (typeof value === 'object' && 'text' in value && typeof value.text === 'string') {
    return value.text.trim() || null;
  }
  return null;
}

export function cellNumber(value: ExcelJS.CellValue): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && value !== null && 'result' in value) {
    const r = (value as { result?: unknown }).result;
    if (typeof r === 'number') return r;
  }
  const t = cellText(value);
  if (t === null) return null;
  const n = Number(t.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}
