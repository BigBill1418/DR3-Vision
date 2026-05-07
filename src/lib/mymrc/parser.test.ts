import { describe, expect, it } from 'vitest';
import { parseScheduledHaulsHtml } from './parser';

// Tests for `src/lib/mymrc/parser.ts`. The parser is the single most
// fragile piece of the MyMRC integration — when MRC redesigns the
// portal, this is the first thing that breaks. These tests guard the
// contract that:
//
//   - Header-driven column lookup tolerates ordering + label drift.
//   - Date / number parsing is strict (Feb 30 → reject; 1,500 → 1500).
//   - Optional fields collapse to null cleanly.
//   - Required-but-missing rows are silently dropped (no throw).
//   - HTML entities + <br>-separated cells decode correctly.
//   - The scheduled-hauls table is found whether wrapped in page chrome
//     or passed as a bare <table> fragment.
//
// All fixtures are inline, hand-built to mirror what the live MyMRC
// portal emits as of the SELECTOR_VERSION date in `selectors.ts`.
// NEVER drive these tests against the live portal — the runbook
// explicitly forbids it (cost / detection / etiquette).

const HAUL_TABLE = `
  <table data-purpose="scheduled-hauls">
    <thead>
      <tr>
        <th>Recycler</th>
        <th>Haul: Haul ID</th>
        <th>Recycler Reported Delivery Date</th>
        <th>Collection Site</th>
        <th>Transporter</th>
        <th>Recycler Program Unit Count</th>
        <th>Reference Number</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>DR3 Eugene</td>
        <td>H-126152</td>
        <td>05/08/2026</td>
        <td>1-800-Got-Junk? - Concord</td>
        <td>Ron Lawrence &amp; Son</td>
        <td>42</td>
        <td>BOL-7788</td>
      </tr>
      <tr>
        <td>DR3 Eugene</td>
        <td>H-126153</td>
        <td>05/09/2026</td>
        <td>Agiliti - Sutter Roseville Medical Center</td>
        <td></td>
        <td>1,250</td>
        <td></td>
      </tr>
    </tbody>
  </table>
`;

describe('parseScheduledHaulsHtml — happy paths', () => {
  it('parses two well-formed rows from a canonical table', () => {
    const hauls = parseScheduledHaulsHtml(HAUL_TABLE);
    expect(hauls).toHaveLength(2);

    const first = hauls[0]!;
    expect(first.external_mymrc_haul_id).toBe('H-126152');
    expect(first.expected_arrival_at.toISOString()).toBe('2026-05-08T12:00:00.000Z');
    expect(first.source_name).toBe('1-800-Got-Junk? - Concord');
    expect(first.transporter_name).toBe('Ron Lawrence & Son');
    expect(first.expected_unit_count).toBe(42);
    expect(first.bol_number).toBe('BOL-7788');
    expect(first.scheduled_at_mymrc).toBeNull();
  });

  it('collapses missing optional cells to null', () => {
    const hauls = parseScheduledHaulsHtml(HAUL_TABLE);
    const second = hauls[1]!;
    expect(second.transporter_name).toBeNull();
    expect(second.bol_number).toBeNull();
    expect(second.expected_unit_count).toBe(1250);
  });

  it('finds the table even when wrapped in page chrome', () => {
    const wrapped = `<!DOCTYPE html><html><body><div class="card">${HAUL_TABLE}</div></body></html>`;
    expect(parseScheduledHaulsHtml(wrapped)).toHaveLength(2);
  });

  it('returns [] when the page has no scheduled-hauls table', () => {
    const noTable = `<!DOCTYPE html><html><body><p>nothing here</p></body></html>`;
    expect(parseScheduledHaulsHtml(noTable)).toEqual([]);
  });

  it('returns [] when the table has only a header row (empty hauls list)', () => {
    const empty = `
      <table data-purpose="scheduled-hauls">
        <thead><tr><th>Haul: Haul ID</th><th>Recycler Reported Delivery Date</th><th>Collection Site</th></tr></thead>
        <tbody></tbody>
      </table>`;
    expect(parseScheduledHaulsHtml(empty)).toEqual([]);
  });
});

describe('parseScheduledHaulsHtml — header tolerance', () => {
  it('accepts a fallback table without the data-purpose attribute', () => {
    const fallback = `
      <table class="scheduled-hauls">
        <tr>
          <th>Haul ID</th>
          <th>Delivery Date</th>
          <th>Collection Site</th>
        </tr>
        <tr>
          <td>H-99001</td>
          <td>06/01/2026</td>
          <td>Drop Site Alpha</td>
        </tr>
      </table>`;
    const hauls = parseScheduledHaulsHtml(fallback);
    expect(hauls).toHaveLength(1);
    expect(hauls[0]!.external_mymrc_haul_id).toBe('H-99001');
  });

  it('handles columns in arbitrary order', () => {
    const reordered = `
      <table data-purpose="scheduled-hauls">
        <tr>
          <th>Collection Site</th>
          <th>Haul: Haul ID</th>
          <th>Reference Number</th>
          <th>Recycler Reported Delivery Date</th>
        </tr>
        <tr>
          <td>Source Beta</td>
          <td>H-77001</td>
          <td>BOL-X1</td>
          <td>05/15/2026</td>
        </tr>
      </table>`;
    const hauls = parseScheduledHaulsHtml(reordered);
    expect(hauls).toHaveLength(1);
    expect(hauls[0]!).toMatchObject({
      external_mymrc_haul_id: 'H-77001',
      source_name: 'Source Beta',
      bol_number: 'BOL-X1',
    });
  });

  it('returns [] when required headers (haul-id) are missing', () => {
    const broken = `
      <table data-purpose="scheduled-hauls">
        <tr><th>Recycler</th><th>Random</th></tr>
        <tr><td>DR3 Eugene</td><td>x</td></tr>
      </table>`;
    expect(parseScheduledHaulsHtml(broken)).toEqual([]);
  });
});

describe('parseScheduledHaulsHtml — value coercion', () => {
  it('rejects malformed dates (Feb 30 rolls into March → drop row)', () => {
    const html = `
      <table data-purpose="scheduled-hauls">
        <tr><th>Haul: Haul ID</th><th>Recycler Reported Delivery Date</th><th>Collection Site</th></tr>
        <tr><td>H-1</td><td>02/30/2026</td><td>S</td></tr>
        <tr><td>H-2</td><td>05/05/2026</td><td>S</td></tr>
      </table>`;
    const hauls = parseScheduledHaulsHtml(html);
    expect(hauls).toHaveLength(1);
    expect(hauls[0]!.external_mymrc_haul_id).toBe('H-2');
  });

  it('drops rows missing required fields (haul-id or date or source)', () => {
    const html = `
      <table data-purpose="scheduled-hauls">
        <tr><th>Haul: Haul ID</th><th>Recycler Reported Delivery Date</th><th>Collection Site</th></tr>
        <tr><td></td><td>05/05/2026</td><td>S</td></tr>
        <tr><td>H-1</td><td></td><td>S</td></tr>
        <tr><td>H-2</td><td>05/05/2026</td><td></td></tr>
        <tr><td>H-3</td><td>05/05/2026</td><td>OK</td></tr>
      </table>`;
    const hauls = parseScheduledHaulsHtml(html);
    expect(hauls.map((h) => h.external_mymrc_haul_id)).toEqual(['H-3']);
  });

  it('strips commas and whitespace from numeric cells', () => {
    const html = `
      <table data-purpose="scheduled-hauls">
        <tr><th>Haul: Haul ID</th><th>Recycler Reported Delivery Date</th><th>Collection Site</th><th>Recycler Program Unit Count</th></tr>
        <tr><td>H-1</td><td>05/05/2026</td><td>S</td><td>  1,250  </td></tr>
        <tr><td>H-2</td><td>05/05/2026</td><td>S</td><td>not-a-number</td></tr>
      </table>`;
    const hauls = parseScheduledHaulsHtml(html);
    expect(hauls).toHaveLength(2);
    expect(hauls[0]!.expected_unit_count).toBe(1250);
    expect(hauls[1]!.expected_unit_count).toBeNull();
  });

  it('decodes common HTML entities and trims whitespace', () => {
    const html = `
      <table data-purpose="scheduled-hauls">
        <tr><th>Haul: Haul ID</th><th>Recycler Reported Delivery Date</th><th>Collection Site</th><th>Transporter</th></tr>
        <tr><td>H-1</td><td>05/05/2026</td><td>  Acme &amp; Sons  </td><td>Bill&#39;s Hauling</td></tr>
      </table>`;
    const hauls = parseScheduledHaulsHtml(html);
    expect(hauls[0]!.source_name).toBe('Acme & Sons');
    expect(hauls[0]!.transporter_name).toBe("Bill's Hauling");
  });

  it('supports two-digit years by adding 2000', () => {
    const html = `
      <table data-purpose="scheduled-hauls">
        <tr><th>Haul: Haul ID</th><th>Recycler Reported Delivery Date</th><th>Collection Site</th></tr>
        <tr><td>H-1</td><td>5/8/26</td><td>S</td></tr>
      </table>`;
    const hauls = parseScheduledHaulsHtml(html);
    expect(hauls[0]!.expected_arrival_at.toISOString()).toBe('2026-05-08T12:00:00.000Z');
  });

  it('parses scheduled-at column when present (ISO format)', () => {
    const html = `
      <table data-purpose="scheduled-hauls">
        <tr><th>Haul: Haul ID</th><th>Recycler Reported Delivery Date</th><th>Collection Site</th><th>Scheduled at</th></tr>
        <tr><td>H-1</td><td>05/08/2026</td><td>S</td><td>2026-05-08T18:30:00Z</td></tr>
      </table>`;
    const hauls = parseScheduledHaulsHtml(html);
    expect(hauls[0]!.scheduled_at_mymrc?.toISOString()).toBe('2026-05-08T18:30:00.000Z');
  });
});
