// ADR-0067 §3.2 D8 — the driveItem projection and the pipeline tunables.
//
// `projectDriveItem` is where the IMMUTABLE identity of a shared document is
// established. Everything downstream (dedup, rename-survival, move-survival)
// depends on it unwrapping the `remoteItem` facet correctly, so it gets its own
// tests rather than being covered incidentally.

import { describe, expect, it } from 'vitest';
import { projectDriveItem } from '../graph';
import {
  docIngestMaxDepth,
  docIngestMaxFileBytes,
  docIngestRowDropThreshold,
  docIngestSubscriptionTtlMinutes,
  sharedWithMeDaysRemaining,
  DOC_INGEST_SUBSCRIPTION_TTL_MAX_MINUTES,
  SHARED_WITH_ME_SUNSET,
} from '../pipeline-config';

describe('projectDriveItem — the remoteItem unwrap', () => {
  it('keys a shared item on its REAL drive and id, not the local stub', () => {
    // This is the sharedWithMe response shape: a local stub whose own `id`
    // belongs to the SERVICE ACCOUNT's drive, wrapping the real item.
    const raw = {
      id: 'local-stub-id',
      remoteItem: {
        id: '1991210caf!192',
        name: 'March Proposal.docx',
        file: {
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
        size: 19121,
        cTag: 'ctag-abc',
        parentReference: { driveId: '1991210caf', id: '1991210caf!104' },
      },
    };

    const projected = projectDriveItem(raw);

    // Keying on the stub would make every source look like it lived in one
    // drive, and would break dedup the moment the same file arrived twice.
    expect(projected?.id).toBe('1991210caf!192');
    expect(projected?.driveId).toBe('1991210caf');
    expect(projected?.name).toBe('March Proposal.docx');
    expect(projected?.isFolder).toBe(false);
    expect(projected?.ctag).toBe('ctag-abc');
  });

  it('handles a plain (non-shared) driveItem too', () => {
    const projected = projectDriveItem({
      id: 'item-1',
      name: 'Local.xlsx',
      file: {},
      parentReference: { driveId: 'drive-A', id: 'folder-1' },
    });
    expect(projected?.id).toBe('item-1');
    expect(projected?.parentItemId).toBe('folder-1');
  });

  it('recognizes a folder', () => {
    const projected = projectDriveItem({
      id: 'f1',
      name: 'Daily Logs',
      folder: { childCount: 3 },
      parentReference: { driveId: 'drive-A' },
    });
    expect(projected?.isFolder).toBe(true);
  });

  it('captures the OWNER, which is the only place that name survives a departure', () => {
    const projected = projectDriveItem({
      id: 'i',
      name: 'x',
      file: {},
      parentReference: { driveId: 'd' },
      shared: { owner: { user: { email: 'kelsey@svdp.us', displayName: 'Kelsey' } } },
    });
    expect(projected?.ownerUpn).toBe('kelsey@svdp.us');
  });

  it('falls back to createdBy when no share owner is present', () => {
    const projected = projectDriveItem({
      id: 'i',
      name: 'x',
      file: {},
      parentReference: { driveId: 'd' },
      createdBy: { user: { userPrincipalName: 'someone@svdp.us' } },
    });
    expect(projected?.ownerUpn).toBe('someone@svdp.us');
  });

  it('marks a deleted item from a delta page', () => {
    const projected = projectDriveItem({
      id: 'i',
      name: 'x',
      parentReference: { driveId: 'd' },
      deleted: { state: 'deleted' },
    });
    expect(projected?.deleted).toBe(true);
  });

  it('uses the fallback drive id when the payload omits parentReference.driveId', () => {
    const projected = projectDriveItem({ id: 'i', name: 'x', file: {} }, 'drive-fallback');
    expect(projected?.driveId).toBe('drive-fallback');
  });

  it('rejects an item with no usable identity rather than inventing one', () => {
    expect(projectDriveItem(null)).toBeNull();
    expect(projectDriveItem({ name: 'no id' })).toBeNull();
    // No drive id and no fallback: unkeyable, so it must not become a source.
    expect(projectDriveItem({ id: 'i', name: 'x' })).toBeNull();
  });
});

describe('pipeline tunables', () => {
  it('defaults to the spec values', () => {
    expect(docIngestMaxDepth()).toBe(5);
    expect(docIngestMaxFileBytes()).toBe(100 * 1024 * 1024);
    expect(docIngestRowDropThreshold()).toBe(0.1);
  });

  it('clamps the subscription TTL to Microsoft’s documented maximum', () => {
    // 42,300 minutes (under 30 days) per learn.microsoft.com. Asking for more is
    // documented to start failing outright.
    process.env['DOC_INGEST_SUBSCRIPTION_TTL_MINUTES'] = '999999';
    expect(docIngestSubscriptionTtlMinutes()).toBe(DOC_INGEST_SUBSCRIPTION_TTL_MAX_MINUTES);
    delete process.env['DOC_INGEST_SUBSCRIPTION_TTL_MINUTES'];
  });

  it('ignores nonsense env values and keeps the safe default', () => {
    process.env['DOC_INGEST_MAX_DEPTH'] = 'banana';
    expect(docIngestMaxDepth()).toBe(5);
    process.env['DOC_INGEST_MAX_DEPTH'] = '-3';
    expect(docIngestMaxDepth()).toBe(5);
    delete process.env['DOC_INGEST_MAX_DEPTH'];
  });

  it('honours a deliberate row-drop threshold of exactly 0 (a real tightening)', () => {
    process.env['DOC_INGEST_ROW_DROP_THRESHOLD'] = '0';
    expect(docIngestRowDropThreshold()).toBe(0);
    delete process.env['DOC_INGEST_ROW_DROP_THRESHOLD'];
  });

  it('counts down to the sharedWithMe sunset and goes negative afterwards', () => {
    // ⚠ Microsoft deprecated /me/drive/sharedWithMe; it stops returning data
    // after this date and there is no documented one-to-one replacement.
    expect(SHARED_WITH_ME_SUNSET).toBe('2026-11-01');
    expect(sharedWithMeDaysRemaining(new Date('2026-10-01T00:00:00Z'))).toBe(31);
    expect(sharedWithMeDaysRemaining(new Date('2026-12-01T00:00:00Z'))).toBeLessThan(0);
  });
});
