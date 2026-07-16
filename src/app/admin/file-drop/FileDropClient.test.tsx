// @vitest-environment jsdom
//
// O-2 — smoke test: the file-drop client renders its dropzone + upload control and
// lists the manifest rows it is handed. Structural only (no upload round-trip).

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FileDropClient } from './FileDropClient';
import type { FileDropRow } from '@/lib/file-drop/list';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const ROW: FileDropRow = {
  id: 'd1',
  originalFilename: 'MARCH 2026 DAILY LOG.xlsm',
  contentType: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  byteSize: 2_500_000,
  status: 'received',
  detectedKind: 'workbook',
  note: null,
  uploadedBy: 'admin-1',
  uploadedByName: 'Bill',
  createdISO: '2026-07-16T18:30:00.000Z',
  downloadable: true,
};

function mount(rows: FileDropRow[]) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<FileDropClient initialRows={rows} />));
}

describe('FileDropClient', () => {
  it('renders the dropzone, a hidden file input, and the upload button', () => {
    mount([]);
    expect(container.querySelector('[data-testid="file-drop-zone"]')).not.toBeNull();
    const input = container.querySelector('[data-testid="file-drop-input"]');
    expect(input).not.toBeNull();
    expect(input?.getAttribute('type')).toBe('file');
    expect(input?.hasAttribute('multiple')).toBe(true);
    // No <form> element anywhere (hard rule #10).
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('[data-testid="file-drop-upload"]')).not.toBeNull();
  });

  it('renders the empty state when there are no drops', () => {
    mount([]);
    expect(container.querySelectorAll('[data-testid="file-drop-row"]').length).toBe(0);
    expect(container.textContent).toContain('Nothing dropped yet.');
  });

  it('lists a manifest row with filename, detected kind, uploader, and a download control', () => {
    mount([ROW]);
    const rowEls = container.querySelectorAll('[data-testid="file-drop-row"]');
    expect(rowEls.length).toBe(1);
    const text = rowEls[0]!.textContent ?? '';
    expect(text).toContain('MARCH 2026 DAILY LOG.xlsm');
    expect(text).toContain('workbook');
    expect(text).toContain('Bill');
    expect(text).toContain('PT'); // Pacific-labeled timestamp
    expect(text).toContain('Download');
  });

  it('shows the not-stored notice for a placeholder-keyed drop', () => {
    mount([{ ...ROW, downloadable: false }]);
    const text = container.querySelector('[data-testid="file-drop-row"]')?.textContent ?? '';
    expect(text).not.toContain('Download');
    expect(text).toContain('Not stored');
  });
});
