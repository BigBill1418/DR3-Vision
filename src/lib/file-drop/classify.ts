// O-2 (2026-07-16) — best-effort file-drop classification.
//
// Advisory ONLY. `detected_kind` is a hint string shown next to a drop so the
// downstream human router (Claude Code) can eyeball what a file probably is. It
// NEVER routes, promotes, or gates anything — the operator makes the real call
// per-file. Pure function, no I/O, so it is trivially unit-tested and stable.
//
// Mapping (extension first, then content-type):
//   .xlsm / .xlsx           → workbook
//   .pdf                    → pdf_document
//   .csv                    → csv
//   content-type image/*    → image
//   everything else         → other

export type DetectedKind = 'workbook' | 'pdf_document' | 'csv' | 'image' | 'other';

/** The final `.ext` (lowercased, no dot) of a filename, or '' if none. */
function extensionOf(filename: string): string {
  const base = filename.trim().toLowerCase();
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1);
}

export function classifyFileDrop(input: {
  filename: string;
  contentType: string | null;
}): DetectedKind {
  const ext = extensionOf(input.filename);
  if (ext === 'xlsm' || ext === 'xlsx') return 'workbook';
  if (ext === 'pdf') return 'pdf_document';
  if (ext === 'csv') return 'csv';

  const ct = (input.contentType ?? '').trim().toLowerCase();
  if (ct.startsWith('image/')) return 'image';

  return 'other';
}
