import { describe, expect, it } from 'vitest';
import {
  buildObjectFixture,
  enumerateObjects,
  estimateCount,
  extractAllRecords,
  extractListViews,
  extractNavMenuHrefs,
  extractRecordFields,
  isGetItemsAction,
  isGetRecordAction,
  listRecordIds,
  objectPagesFromHrefs,
  objectSlugFromHref,
  parseAuraActions,
  redactRecord,
  renderDiscoveryMarkdown,
  resolveObjectPages,
  summarizeSobjectsProbe,
  type DiscoveredObjectReport,
} from './discovery';
import { OBJECT_NAV_SLUGS } from './selectors';
import type { SfRecord } from './types';

import homeMulti from './__fixtures__/discovery/home-getitems-multi.json';
import descriptorless from './__fixtures__/discovery/descriptorless-getitems.json';
import accountEnvelope from './__fixtures__/discovery/account-getrecord-envelope.json';
import navMenu from './__fixtures__/discovery/nav-getnavigationmenu.json';
import haulsListPage from './__fixtures__/discovery/hauls-list-page.json';

const homeBody = JSON.stringify(homeMulti);
const descriptorlessBody = JSON.stringify(descriptorless);
const accountBody = JSON.stringify(accountEnvelope);
const navBody = JSON.stringify(navMenu);
const haulsPageBody = JSON.stringify(haulsListPage);
const ACCOUNT_ID = '001UJ000001Aa11YAM';

// ── Aura action layer ────────────────────────────────────────────────────────

describe('parseAuraActions', () => {
  it('returns the actions array, tolerating junk', () => {
    expect(parseAuraActions(homeBody)).toHaveLength(2);
    expect(parseAuraActions('<html>not json</html>')).toEqual([]);
    expect(parseAuraActions('{"context":{}}')).toEqual([]);
    expect(parseAuraActions('{"actions":[null,"x",{"id":"1"}]}')).toHaveLength(1);
  });

  it('preserves descriptor + params for classification/enumeration', () => {
    const first = parseAuraActions(homeBody)[0];
    expect(first?.descriptor).toContain('getItems');
    expect(first?.params?.['entityName']).toBe('Account');
  });
});

describe('isGetItemsAction / isGetRecordAction', () => {
  it('classifies by descriptor', () => {
    const getItems = parseAuraActions(homeBody)[0];
    const getRecord = parseAuraActions(accountBody)[0];
    expect(getItems && isGetItemsAction(getItems)).toBe(true);
    expect(getItems && isGetRecordAction(getItems)).toBe(false);
    expect(getRecord && isGetRecordAction(getRecord)).toBe(true);
  });

  it('falls back to shape when the descriptor is absent', () => {
    const action = parseAuraActions(descriptorlessBody)[0];
    expect(action?.descriptor).toBeUndefined();
    expect(action && isGetItemsAction(action)).toBe(true);
  });
});

// ── Count + ids ──────────────────────────────────────────────────────────────

describe('listRecordIds / estimateCount', () => {
  it('extracts ids and marks a complete page as exact', () => {
    const rv = parseAuraActions(homeBody)[0]?.returnValue;
    expect(listRecordIds(rv)).toEqual(['001UJ000001Aa11YAM', '001UJ000001Bb22YAM', '001UJ000001Cc33YAM']);
    expect(estimateCount(rv)).toEqual({ listed: 3, windowed: false, pageOffset: 50, known: true });
  });

  it('marks a windowed page as a floor (not the total)', () => {
    const rv = parseAuraActions(homeBody)[1]?.returnValue;
    expect(estimateCount(rv)).toEqual({ listed: 2, windowed: true, pageOffset: 50, known: false });
  });

  it('ignores blank/malformed id entries', () => {
    const rv = { recordIdActionsList: [{ recordId: 'a' }, { recordId: '' }, null, { recordId: 42 }] };
    expect(listRecordIds(rv)).toEqual(['a']);
    expect(listRecordIds(null)).toEqual([]);
  });
});

// ── List-view + object enumeration ───────────────────────────────────────────

describe('extractListViews', () => {
  it('extracts one view per getItems action with columns + queried fields', () => {
    const views = extractListViews([homeBody]);
    expect(views).toHaveLength(2);
    const account = views[0];
    expect(account?.objectApiName).toBe('Account');
    expect(account?.keyPrefix).toBe('001');
    expect(account?.filterTitle).toBe('All Accounts');
    expect(account?.columns).toEqual(['Name', 'BillingCity', 'Recycler__c']);
    expect(account?.queriedFields).toContain('Id');
    expect(account?.isErrorListView).toBe(false);
  });
});

describe('enumerateObjects', () => {
  it('enumerates objects by params.entityName (primary path)', () => {
    const objects = enumerateObjects([homeBody]);
    expect(objects.map((o) => o.objectApiName)).toEqual(['Account', 'Haul_Request__c']);
    const haul = objects[1];
    expect(haul?.count.windowed).toBe(true);
    expect(haul?.count.known).toBe(false);
    expect(haul?.recordIds).toHaveLength(2);
  });

  it('resolves a descriptor-less list view by key prefix from a fetched record', () => {
    const records = extractAllRecords([accountBody]);
    const objects = enumerateObjects([descriptorlessBody], records);
    expect(objects).toHaveLength(1);
    expect(objects[0]?.objectApiName).toBe('Account');
    expect(objects[0]?.keyPrefix).toBe('001');
  });

  it('leaves the object unnamed (prefix key) when no record cross-links it', () => {
    const objects = enumerateObjects([descriptorlessBody]);
    expect(objects[0]?.objectApiName).toBeNull();
    expect(objects[0]?.keyPrefix).toBe('001');
  });

  it('merges multiple list views of the same object (union ids + columns + labels)', () => {
    const records = extractAllRecords([accountBody]);
    const objects = enumerateObjects([homeBody, descriptorlessBody], records);
    expect(objects.map((o) => o.objectApiName)).toEqual(['Account', 'Haul_Request__c']);
    const account = objects[0];
    expect(account?.recordIds).toEqual([
      '001UJ000001Aa11YAM',
      '001UJ000001Bb22YAM',
      '001UJ000001Cc33YAM',
      '001UJ000001Dd44YAM',
    ]);
    expect(account?.listViews).toEqual(['All Accounts', 'Recently Viewed Accounts']);
    expect(account?.columns).toContain('Type'); // contributed by the 2nd list view
  });
});

// ── Nav-based object-page discovery (ADR-0057 Phase 0 live fix) ───────────────

describe('objectSlugFromHref', () => {
  it('extracts object slugs from relative and absolute portal hrefs', () => {
    expect(objectSlugFromHref('/s/hauls')).toBe('hauls');
    expect(objectSlugFromHref('https://mrc-us.my.site.com/s/processed-materials')).toBe(
      'processed-materials',
    );
    expect(objectSlugFromHref('/s/outbound-materials/')).toBe('outbound-materials');
    expect(objectSlugFromHref('/s/hauls?foo=bar#top')).toBe('hauls');
  });

  it('preserves the live trailing-dash slug (illegal-dump-cip-)', () => {
    expect(objectSlugFromHref('/s/illegal-dump-cip-')).toBe('illegal-dump-cip-');
  });

  it('rejects non-object pages: Home, FAQs, Support, Reports, login, detail', () => {
    expect(objectSlugFromHref('/s/')).toBeNull();
    expect(objectSlugFromHref('/s/home')).toBeNull();
    expect(objectSlugFromHref('/s/help-articles')).toBeNull();
    expect(objectSlugFromHref('/s/contact')).toBeNull();
    expect(objectSlugFromHref('/s/report/Report/Recent')).toBeNull();
    expect(objectSlugFromHref('/s/login/')).toBeNull();
    expect(objectSlugFromHref('/s/detail/a2KUJ00000G6id32AB')).toBeNull();
    expect(objectSlugFromHref('https://example.com/other')).toBeNull();
    expect(objectSlugFromHref('')).toBeNull();
  });
});

describe('objectPagesFromHrefs', () => {
  it('filters + dedupes a raw href list to ordered object slugs', () => {
    expect(
      objectPagesFromHrefs([
        '/s/',
        '/s/hauls',
        '/s/hauls',
        '/s/help-articles',
        '/s/processed-materials',
        '/s/report/Report/Recent',
        '/s/contact',
      ]),
    ).toEqual(['hauls', 'processed-materials']);
  });
});

describe('extractNavMenuHrefs', () => {
  it('reads menuItems (incl. subMenu) targets from a getNavigationMenu response', () => {
    const hrefs = extractNavMenuHrefs([navBody]);
    expect(hrefs).toContain('/s/hauls');
    expect(hrefs).toContain('/s/outbound-vendors'); // nested in subMenu
    expect(hrefs).toContain('/s/records-review'); // nested in subMenu
    expect(hrefs).toContain('/s/report/Report/Recent'); // non-object; filtered later
  });

  it('returns [] when no nav action is present', () => {
    expect(extractNavMenuHrefs([homeBody])).toEqual([]);
    expect(extractNavMenuHrefs(['{"actions":[]}'])).toEqual([]);
  });
});

describe('resolveObjectPages', () => {
  it('yields the seven live object pages from the nav (Home/FAQs/Support/Reports skipped)', () => {
    const slugs = resolveObjectPages({ navBodies: [navBody] });
    expect(slugs).toEqual([
      'hauls',
      'illegal-dump-cip-',
      'processed-materials',
      'outbound-materials',
      'availability',
      'outbound-vendors',
      'records-review',
    ]);
    // Exactly the object allowlist, in nav order.
    expect([...slugs].sort()).toEqual([...OBJECT_NAV_SLUGS].sort());
  });

  it('merges DOM links and dedupes against the nav', () => {
    const slugs = resolveObjectPages({
      navBodies: [navBody],
      domHrefs: ['/s/hauls', 'https://mrc-us.my.site.com/s/availability'],
    });
    expect(slugs.filter((s) => s === 'hauls')).toHaveLength(1);
    expect(slugs.filter((s) => s === 'availability')).toHaveLength(1);
  });

  it('falls back to the static allowlist when nav + DOM yield nothing', () => {
    expect(resolveObjectPages({ navBodies: [], domHrefs: [], fallbackSlugs: OBJECT_NAV_SLUGS })).toEqual(
      [...OBJECT_NAV_SLUGS],
    );
  });
});

describe('enumerateObjects — per-object list pages (not /s/home)', () => {
  it('enumerates an object from its own ListView page getItems', () => {
    const objects = enumerateObjects([haulsPageBody]);
    expect(objects).toHaveLength(1);
    const haul = objects[0];
    expect(haul?.objectApiName).toBe('Haul__c');
    expect(haul?.keyPrefix).toBe('a2K');
    expect(haul?.recordIds).toEqual([
      'a2KUJ00000G6id32AB',
      'a2KUJ00000G7ab99AB',
      'a2KUJ00000G8cd11AB',
    ]);
    expect(haul?.columns).toContain('Recycler__c');
    expect(haul?.count).toEqual({ listed: 3, windowed: false, pageOffset: 0, known: true });
  });

  it('merges getItems across multiple object pages into distinct objects', () => {
    // Two per-object-page bodies (the real enumeration accumulates one per nav slug).
    const objects = enumerateObjects([haulsPageBody, homeBody]);
    expect(objects.map((o) => o.objectApiName)).toEqual(['Haul__c', 'Account', 'Haul_Request__c']);
  });
});

// ── Record walking ───────────────────────────────────────────────────────────

describe('extractAllRecords / extractRecordFields', () => {
  it('collects the Account plus its nested person records', () => {
    const ids = extractAllRecords([accountBody]).map((r) => r.id);
    expect(ids).toContain(ACCOUNT_ID);
    expect(ids).toContain('005UJ0000011jXaYAI'); // Owner (User)
    expect(ids).toContain('003UJ000002Zz99YAM'); // Primary_Contact__r (Contact)
  });

  it('returns the richest representation for a given id, null when absent', () => {
    const rec = extractRecordFields([accountBody], ACCOUNT_ID);
    expect(rec?.apiName).toBe('Account');
    expect(Object.keys(rec?.fields ?? {})).toContain('Recycler__c');
    expect(extractRecordFields([accountBody], 'nope')).toBeNull();
  });
});

// ── Redaction ────────────────────────────────────────────────────────────────

describe('redactRecord', () => {
  const account = extractRecordFields([accountBody], ACCOUNT_ID) as SfRecord;
  const redacted = redactRecord(account);

  it('retains business fields (object identity, site, city)', () => {
    expect(redacted.fields['Name']?.value).toBe('DR3 Woodland');
    expect(redacted.fields['Recycler__c']?.value).toBe('DR3 Woodland');
    expect(redacted.fields['BillingCity']?.value).toBe('Woodland');
  });

  it('redacts direct PII on the record (phone)', () => {
    expect(redacted.fields['Phone']?.value).toBe('[redacted]');
  });

  it('redacts nested person relationships (Owner/CreatedBy User) name + email + displayValue', () => {
    const owner = redacted.fields['Owner']?.value as SfRecord;
    expect(owner.fields['Name']?.value).toBe('[redacted]');
    expect(owner.fields['Email']?.value).toBe('[redacted]');
    expect(redacted.fields['Owner']?.displayValue).toBe('[redacted]');
    const createdBy = redacted.fields['CreatedBy']?.value as SfRecord;
    expect(createdBy.fields['Name']?.value).toBe('[redacted]');
  });

  it('redacts a nested Contact fully (name, first/last, email, mobile)', () => {
    const contact = redacted.fields['Primary_Contact__r']?.value as SfRecord;
    expect(contact.fields['Name']?.value).toBe('[redacted]');
    expect(contact.fields['FirstName']?.value).toBe('[redacted]');
    expect(contact.fields['LastName']?.value).toBe('[redacted]');
    expect(contact.fields['Email']?.value).toBe('[redacted]');
    expect(contact.fields['MobilePhone']?.value).toBe('[redacted]');
    expect(redacted.fields['Primary_Contact__r']?.displayValue).toBe('[redacted]');
  });

  it('does not mutate the input record', () => {
    expect(account.fields['Phone']?.value).toBe('+1-555-0100');
    const owner = account.fields['Owner']?.value as SfRecord;
    expect(owner.fields['Name']?.value).toBe('Jane Operator');
  });

  it('redacts a flat dotted person key while keeping business fields (Materials__c)', () => {
    const flat: SfRecord = {
      apiName: 'Materials__c',
      id: 'a2LUJ000001N4gf2AC',
      fields: {
        Name: { displayValue: null, value: 'M-000300' },
        'CreatedBy.Name': { displayValue: 'Sam Admin', value: 'Sam Admin' },
        Weight__c: { displayValue: null, value: 1234 },
      },
    };
    const out = redactRecord(flat);
    expect(out.fields['Name']?.value).toBe('M-000300'); // business Name retained
    expect(out.fields['CreatedBy.Name']?.value).toBe('[redacted]');
    expect(out.fields['CreatedBy.Name']?.displayValue).toBe('[redacted]');
    expect(out.fields['Weight__c']?.value).toBe(1234);
  });
});

// ── sObjects probe ───────────────────────────────────────────────────────────

describe('summarizeSobjectsProbe', () => {
  it('captures a reachable metadata API (200)', () => {
    const body = JSON.stringify({ sobjects: [{ name: 'Account' }, { name: 'Contact' }] });
    const p = summarizeSobjectsProbe(200, body);
    expect(p).toMatchObject({ reachable: true, status: 200, sobjectCount: 2 });
    expect(p.sampleObjectNames).toEqual(['Account', 'Contact']);
  });

  it('records a permission denial (401/403) as an expected finding, not a crash', () => {
    for (const status of [401, 403]) {
      const p = summarizeSobjectsProbe(status, 'Forbidden');
      expect(p.reachable).toBe(false);
      expect(p.status).toBe(status);
      expect(p.note).toMatch(/not permitted/i);
    }
  });

  it('handles a 200 with a non-JSON body and other statuses', () => {
    expect(summarizeSobjectsProbe(200, 'nope').note).toMatch(/not parseable/i);
    expect(summarizeSobjectsProbe(500, '').reachable).toBe(false);
  });
});

// ── Markdown + fixture bundle ────────────────────────────────────────────────

function sampleReport(): DiscoveredObjectReport {
  return {
    objectApiName: 'Account',
    keyPrefix: '001',
    listViews: ['All Accounts'],
    columns: ['Name', 'Recycler__c'],
    count: { listed: 3, windowed: false, pageOffset: 50, known: true },
    sampleRecordId: ACCOUNT_ID,
    fieldNames: ['BillingCity', 'Name', 'Recycler__c'],
  };
}

describe('renderDiscoveryMarkdown', () => {
  it('renders a catalog table and a per-object section', () => {
    const md = renderDiscoveryMarkdown({
      capturedAt: '2026-07-22',
      portalOrigin: 'https://mrc-us.my.site.com',
      accountLabel: 'dr3-admin',
      objects: [sampleReport()],
      sobjectsProbe: summarizeSobjectsProbe(401, 'Forbidden'),
    });
    expect(md).toContain('# MyMRC discovery — 2026-07-22');
    expect(md).toContain('**Objects discovered:** 1');
    expect(md).toContain('| `Account` |');
    expect(md).toContain('## `Account`');
    expect(md).toContain('3 (exact)');
    expect(md).toContain('sObjects metadata probe');
    expect(md).toContain('HTTP 401');
  });

  it('marks a windowed count as a floor in the catalog', () => {
    const report = sampleReport();
    report.count = { listed: 2, windowed: true, pageOffset: 50, known: false };
    const md = renderDiscoveryMarkdown({
      capturedAt: '2026-07-22',
      portalOrigin: 'https://mrc-us.my.site.com',
      accountLabel: 'dr3-admin',
      objects: [report],
      sobjectsProbe: summarizeSobjectsProbe(200, JSON.stringify({ sobjects: [] })),
    });
    expect(md).toContain('≥ 2 (windowed');
  });
});

describe('buildObjectFixture', () => {
  it('assembles list + REDACTED record + metadata envelopes', () => {
    const record = extractRecordFields([accountBody], ACCOUNT_ID);
    const listRv = parseAuraActions(homeBody)[0]?.returnValue;
    const bundle = buildObjectFixture({
      report: sampleReport(),
      listReturnValue: listRv,
      record,
      capturedAt: '2026-07-22',
    });
    expect(bundle.objectApiName).toBe('Account');
    expect(bundle.metadata.redacted).toBe(true);
    expect(bundle.metadata.capturedAt).toBe('2026-07-22');
    // The record inside the bundle is redacted.
    const env = bundle.recordResponse as { actions: Array<{ returnValue: SfRecord }> };
    const owner = env.actions[0]?.returnValue.fields['Owner']?.value as SfRecord;
    expect(owner.fields['Name']?.value).toBe('[redacted]');
    // The list envelope carries the record ids intact.
    const listEnv = bundle.listResponse as { actions: Array<{ returnValue: unknown }> };
    expect(listRecordIds(listEnv.actions[0]?.returnValue)).toHaveLength(3);
  });

  it('tolerates a null record (no detail captured)', () => {
    const bundle = buildObjectFixture({
      report: { ...sampleReport(), sampleRecordId: null, fieldNames: [] },
      listReturnValue: { recordIdActionsList: [] },
      record: null,
      capturedAt: '2026-07-22',
    });
    const env = bundle.recordResponse as { actions: Array<{ returnValue: unknown }> };
    expect(env.actions[0]?.returnValue).toBeNull();
  });
});
