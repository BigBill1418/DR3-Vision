// ADR-0085 — the drop-off photo key is SITE-scoped, and the submit handler
// checks it.
//
// `photoStorageKey` arrives from the client. On this fleet that means it arrives
// from an iPad's IndexedDB, possibly days after it was minted, on a device shared
// across a shift. The `consumer_dropoffs_floor_requires_photo` constraint only
// requires the column to be NON-NULL — it has no opinion about WHICH object the
// key names. Without this check a submitted drop-off could name any string at
// all, including an object belonging to the other site, and the row would record
// it as its evidence.
//
// Eugene and Woodland are separate MRC contracts in separate jurisdictions
// (CLAUDE.md hard rule #2). A cross-site photo reference is a compliance problem,
// not a tidiness one — the same reason ADR-0078 Am.1 loosened the load-photo gate
// to the site and went no further.

import { describe, expect, it } from 'vitest';
import { dropoffStorageKeyPrefix, isValidDropoffStorageKey } from './r2';

const EUGENE = 'site-eugene';
const WOODLAND = 'site-woodland';

describe('ADR-0085 — drop-off storage-key scoping', () => {
  it('accepts a key this site could have minted', () => {
    expect(isValidDropoffStorageKey(`${dropoffStorageKeyPrefix(EUGENE)}abc.jpg`, EUGENE)).toBe(true);
  });

  it('CROSS-SITE REFUSED — Woodland cannot claim a Eugene object as its evidence', () => {
    const eugeneObject = `${dropoffStorageKeyPrefix(EUGENE)}abc.jpg`;
    expect(
      isValidDropoffStorageKey(eugeneObject, WOODLAND),
      `Woodland accepted "${eugeneObject}" — a cross-contract photo reference`,
    ).toBe(false);
  });

  it('refuses a key that walks out of its own site prefix', () => {
    // `..` is not filesystem traversal in an S3 key, but a key that escapes its
    // site segment defeats the prefix check above — which is the only thing tying
    // the object to the site that claimed it.
    expect(isValidDropoffStorageKey(`${dropoffStorageKeyPrefix(EUGENE)}../${WOODLAND}/x.jpg`, EUGENE)).toBe(
      false,
    );
    expect(isValidDropoffStorageKey(`${dropoffStorageKeyPrefix(EUGENE)}nested/x.jpg`, EUGENE)).toBe(
      false,
    );
    expect(isValidDropoffStorageKey(dropoffStorageKeyPrefix(EUGENE), EUGENE)).toBe(false);
  });

  it('refuses an arbitrary string and another feature’s prefix', () => {
    expect(isValidDropoffStorageKey('anything', EUGENE)).toBe(false);
    // A load photo is not a drop-off photo. Accepting one here would let a
    // drop-off cite a truck's BOL as its walk-up evidence.
    expect(isValidDropoffStorageKey('loads/some-load/bol/x.jpg', EUGENE)).toBe(false);
    // …and the AP prefix, which holds vendor invoices with bank details on them.
    expect(isValidDropoffStorageKey('ap/req/att/invoice.pdf', EUGENE)).toBe(false);
  });

  it('accepts the unconfigured-R2 placeholder, which is non-fetchable by construction', () => {
    // `mintDropoffUploadUrl` returns this whenever R2 is unprovisioned (dev, and
    // the pre-provisioning window). Refusing it would make the whole flow
    // unusable in exactly the environments the tests run in, and the placeholder
    // names no object.
    expect(isValidDropoffStorageKey('pending-r2-dropoff-abc.jpg', EUGENE)).toBe(true);
  });
});
