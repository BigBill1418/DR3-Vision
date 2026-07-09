// ADR-0049 D2/D4/D6 — the fixture-driven mock Files transport (the DEFAULT until
// the tenant grant + a real workbook file land). Zero code between mock and live:
// it satisfies the same `FilesTransport` contract, self-reports `mode='mock'`, and
// supports the failure modes the contract tests exercise (forbidden = missing
// Files.Read.All, not-found = empty new month, ctag-stable = delta no-op).
//
// The mock holds an in-memory folder of named files, each with bytes + a mutable
// ctag. A test flips a file's bytes/ctag to simulate an edit; leaving the ctag
// unchanged simulates the delta no-redownload path.

import { FilesForbiddenError, type FilesTransport } from './transport';
import type { DriveFile } from './types';

export interface MockFileSpec {
  id: string;
  name: string;
  ctag: string;
  lastModified?: string;
  bytes: Uint8Array;
}

export interface MockFilesTransportOptions {
  /** Files present in the drive folder. */
  files?: MockFileSpec[];
  /** Every method throws FilesForbiddenError (D6 / test-plan-8 fail-soft). */
  forbidden?: boolean;
}

export interface MockFilesTransport extends FilesTransport {
  /** Downloads performed since construction — lets a test assert a re-download did / did not happen. */
  readonly downloadCount: number;
  /** Replace a file's bytes + ctag in place (simulate an edit between polls). */
  setFile(name: string, bytes: Uint8Array, ctag: string): void;
  /** Remove all files (simulate a not-yet-created new-month file, D5). */
  clear(): void;
}

export function mockFilesTransport(opts: MockFilesTransportOptions = {}): MockFilesTransport {
  const store = new Map<string, MockFileSpec>();
  for (const f of opts.files ?? []) store.set(f.name.toLowerCase(), { ...f, bytes: new Uint8Array(f.bytes) });
  let downloadCount = 0;

  function guard(): void {
    if (opts.forbidden) throw new FilesForbiddenError('mock: simulated 403 (Files.Read.All missing)');
  }

  function toDriveFile(spec: MockFileSpec): DriveFile {
    return { id: spec.id, name: spec.name, ctag: spec.ctag, lastModified: spec.lastModified ?? '', size: spec.bytes.length };
  }

  return {
    mode: 'mock',
    get downloadCount() {
      return downloadCount;
    },
    setFile(name: string, bytes: Uint8Array, ctag: string): void {
      const key = name.toLowerCase();
      const existing = store.get(key);
      const id = existing?.id ?? `mock-file-${key}`;
      store.set(key, { id, name, ctag, bytes: new Uint8Array(bytes), lastModified: new Date().toISOString() });
    },
    clear(): void {
      store.clear();
    },

    async listFolder(): Promise<DriveFile[]> {
      guard();
      return [...store.values()].map(toDriveFile);
    },

    async getFile(_driveUpn: string, _folderPath: string, fileName: string): Promise<DriveFile | null> {
      guard();
      const spec = store.get(fileName.toLowerCase());
      return spec ? toDriveFile(spec) : null;
    },

    async downloadFile(_driveUpn: string, fileId: string): Promise<Uint8Array> {
      guard();
      const spec = [...store.values()].find((f) => f.id === fileId);
      if (!spec) throw new Error(`mock: file id ${fileId} not found`);
      downloadCount += 1;
      return new Uint8Array(spec.bytes);
    },
  };
}
