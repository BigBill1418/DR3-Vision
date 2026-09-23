// @vitest-environment jsdom
//
// ADR-0063 / ADR-0135 D — the STRUCTURED create form.
//
// Locks down:
//   * the ADR-0017 Amendment 1 contracts (save/cancel return to the FILTERED
//     list; the site select seeds from `?site=`, never `sites[0]` — sites are
//     ordered by name, so `sites[0]` is ALWAYS Eugene and a Woodland-scoped
//     create would be born at the wrong yard: hard rule #2);
//   * ADR-0135 D — no free-typed name: the preview is `generateDisplayName`, and
//     a unit number is required exactly for the types that require one;
//   * ADR-0135 C — a `probable_duplicate` 409 is a fork: "Use this one", or "It's
//     a different asset" WITH a reason, resubmitted with EVERY shown id; a
//     `name_taken` / `vin_taken` 409 is not overridable.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EquipmentCreateForm } from './EquipmentCreateForm';

const push = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Ordered by name, exactly as the page's `findMany({ orderBy: { name: 'asc' } })`.
const SITES = [
  { id: 'site-eugene', code: 'eugene', name: 'DR3 Eugene' },
  { id: 'site-woodland', code: 'woodland', name: 'DR3 Woodland' },
];

let container: HTMLDivElement;
let root: Root;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  push.mockReset();
  refresh.mockReset();
});

function mount(node: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(node));
}

const q = <T extends HTMLElement>(testid: string) =>
  container.querySelector(`[data-testid="${testid}"]`) as T | null;

function setValue(testid: string, value: string) {
  const el = q<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(testid)!;
  const proto = Object.getPrototypeOf(el) as object;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(
      new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
    );
  });
}

async function click(testid: string) {
  await act(async () => {
    q(testid)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const errorText = () => q('admin-equipment-create-error')?.textContent ?? null;
const bodyOf = (fetchMock: ReturnType<typeof vi.fn>, call = 0) =>
  JSON.parse(String(fetchMock.mock.calls[call]?.[1]?.body)) as Record<string, unknown>;

function okFetch() {
  const fetchMock = vi
    .fn()
    .mockResolvedValue({ ok: true, status: 201, json: async () => ({ equipment: { id: 'eq1' } }) });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** A trailer with a unit number — the minimum a valid create needs. */
function fillTrailer(unit = '5327') {
  setValue('admin-equipment-create-type', 'trailer');
  setValue('admin-equipment-create-unit', unit);
}

describe('site default', () => {
  it('defaults to the site the list was filtered to (Woodland), not sites[0]', () => {
    mount(<EquipmentCreateForm sites={SITES} initialSiteCode="woodland" />);
    expect(q<HTMLSelectElement>('admin-equipment-create-site')!.value).toBe('site-woodland');
  });

  it('falls back to sites[0] with no filter, and for an unknown site code', () => {
    mount(<EquipmentCreateForm sites={SITES} initialSiteCode="nowhere" />);
    expect(q<HTMLSelectElement>('admin-equipment-create-site')!.value).toBe('site-eugene');
  });

  it('defaults to Fleet-wide when the list was filtered to fleet-wide', () => {
    mount(<EquipmentCreateForm sites={SITES} initialSiteCode="fleet" />);
    expect(q<HTMLSelectElement>('admin-equipment-create-site')!.value).toBe('fleet');
  });

  it('POSTs the Woodland site id when created from a Woodland-scoped list', async () => {
    const fetchMock = okFetch();
    mount(<EquipmentCreateForm sites={SITES} initialSiteCode="woodland" />);
    fillTrailer();
    await click('admin-equipment-create-submit');
    expect(bodyOf(fetchMock)['siteId']).toBe('site-woodland');
  });

  it('POSTs siteId null for Fleet-wide', async () => {
    const fetchMock = okFetch();
    mount(<EquipmentCreateForm sites={SITES} />);
    fillTrailer();
    setValue('admin-equipment-create-site', 'fleet');
    await click('admin-equipment-create-submit');
    expect(bodyOf(fetchMock)['siteId']).toBeNull();
  });
});

describe('structured fields and the generated name', () => {
  it('has no free-typed name field at all', () => {
    mount(<EquipmentCreateForm sites={SITES} />);
    expect(q('admin-equipment-create-name')).toBeNull();
  });

  it('previews the name the server will generate: <unit> — <make> <details> <type>', () => {
    mount(<EquipmentCreateForm sites={SITES} />);
    fillTrailer('5327');
    setValue('admin-equipment-create-make', 'Great Dane');
    setValue('admin-equipment-create-details', '48 Ft Swing Door');
    expect(q('admin-equipment-create-preview')!.textContent).toContain(
      '5327 — Great Dane 48 Ft Swing Door Trailer',
    );
  });

  it('shows a prompt instead of a name until a type is chosen', () => {
    mount(<EquipmentCreateForm sites={SITES} />);
    expect(q('admin-equipment-create-preview')!.textContent).toContain('Choose a type');
  });

  it('seeds the type from the list category filter and from a structured request', () => {
    mount(<EquipmentCreateForm sites={SITES} initialCategory="forklift" />);
    expect(q<HTMLSelectElement>('admin-equipment-create-type')!.value).toBe('forklift');
    act(() => root.unmount());
    container.remove();
    mount(
      <EquipmentCreateForm
        sites={SITES}
        initialAssetType="semi_truck"
        initialUnitNumber="161053"
        initialMake="Freightliner"
      />,
    );
    expect(q<HTMLSelectElement>('admin-equipment-create-type')!.value).toBe('semi_truck');
    expect(q('admin-equipment-create-preview')!.textContent).toContain(
      '161053 — Freightliner Semi Truck',
    );
  });

  it('sends the structured body — type, unit, make, details, VIN — and no display name', async () => {
    const fetchMock = okFetch();
    mount(<EquipmentCreateForm sites={SITES} />);
    fillTrailer(' 5327 ');
    setValue('admin-equipment-create-make', 'Great  Dane');
    setValue('admin-equipment-create-vin', '1DW1A5321PS807745');
    await click('admin-equipment-create-submit');
    const body = bodyOf(fetchMock);
    expect(body).toMatchObject({
      assetType: 'trailer',
      unitNumber: '5327',
      make: 'Great Dane',
      vinSerial: '1DW1A5321PS807745',
    });
    expect(body).not.toHaveProperty('details');
    expect(body).not.toHaveProperty('display_name');
    expect(body).not.toHaveProperty('displayName');
  });
});

describe('client-side validation', () => {
  it('refuses a create with no type', async () => {
    const fetchMock = okFetch();
    mount(<EquipmentCreateForm sites={SITES} />);
    await click('admin-equipment-create-submit');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorText()).toContain('Choose what kind of asset');
  });

  it('REQUIRES a unit number for a trailer', async () => {
    const fetchMock = okFetch();
    mount(<EquipmentCreateForm sites={SITES} />);
    setValue('admin-equipment-create-type', 'trailer');
    await click('admin-equipment-create-submit');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorText()).toContain('unit number');
  });

  it('does NOT require a unit number for a baler', async () => {
    const fetchMock = okFetch();
    mount(<EquipmentCreateForm sites={SITES} />);
    setValue('admin-equipment-create-type', 'baler');
    setValue('admin-equipment-create-make', 'Harris');
    await click('admin-equipment-create-submit');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyOf(fetchMock)).not.toHaveProperty('unitNumber');
  });

  it('refuses two unit numbers in one field', async () => {
    const fetchMock = okFetch();
    mount(<EquipmentCreateForm sites={SITES} />);
    fillTrailer('5327 5340');
    await click('admin-equipment-create-submit');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorText()).toContain('One unit number only');
  });
});

describe('navigation', () => {
  it('returns to the FILTERED list on save, not the bare list', async () => {
    okFetch();
    const backHref = '/admin/equipment?site=woodland&category=terex&status=all';
    mount(<EquipmentCreateForm sites={SITES} initialSiteCode="woodland" backHref={backHref} />);
    fillTrailer();
    await click('admin-equipment-create-submit');
    expect(push).toHaveBeenCalledWith(backHref);
    expect(refresh).toHaveBeenCalled();
  });

  it('returns to the FILTERED list on cancel', async () => {
    const backHref = '/admin/equipment?site=woodland';
    mount(<EquipmentCreateForm sites={SITES} backHref={backHref} />);
    await click('admin-equipment-create-cancel');
    expect(push).toHaveBeenCalledWith(backHref);
  });

  it('calls onSaved instead of navigating when the caller supplies it', async () => {
    okFetch();
    const onSaved = vi.fn();
    mount(<EquipmentCreateForm sites={SITES} onSaved={onSaved} />);
    fillTrailer();
    await click('admin-equipment-create-submit');
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });

  it('does not navigate when the server rejects the create', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        json: async () => ({ error: 'One of the fields is too long.', code: 'field_too_long' }),
      }),
    );
    mount(<EquipmentCreateForm sites={SITES} />);
    fillTrailer();
    await click('admin-equipment-create-submit');
    expect(push).not.toHaveBeenCalled();
    expect(errorText()).toContain('too long');
  });
});

// ── ADR-0135 C — the refusal is a fork, not a wall ────────────────────────────

const ROW = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  displayName: `5327 — Great Dane Trailer (${id})`,
  category: 'vehicle',
  siteCode: 'woodland',
  isActive: true,
  mergedIntoId: null,
  ...extra,
});

function refusal(code: string, existing: unknown[]) {
  return {
    ok: false,
    status: 409,
    json: async () => ({ error: `refused: ${code}`, code, existing }),
  };
}

describe('409 probable_duplicate — overridable with a reason', () => {
  const EXISTING = [ROW('eq-1'), ROW('eq-2', { siteCode: null })];

  async function refused(fetchMock: ReturnType<typeof vi.fn>, onUseExisting?: () => void) {
    vi.stubGlobal('fetch', fetchMock);
    mount(<EquipmentCreateForm sites={SITES} onUseExisting={onUseExisting} />);
    fillTrailer();
    await click('admin-equipment-create-submit');
  }

  it('shows the matches (site code, or "fleet"), "Use this one", and "It\'s a different asset"', async () => {
    await refused(vi.fn().mockResolvedValueOnce(refusal('probable_duplicate', EXISTING)), vi.fn());
    expect(q('admin-equipment-similar-eq-1')!.textContent).toContain('woodland');
    expect(q('admin-equipment-similar-eq-2')!.textContent).toContain('fleet');
    expect(q('admin-equipment-use-existing-eq-1')).not.toBeNull();
    expect(q('admin-equipment-different-asset')).not.toBeNull();
    expect(push).not.toHaveBeenCalled();
  });

  it('the override needs a reason of at least 10 characters, then resubmits with EVERY shown id', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(refusal('probable_duplicate', EXISTING))
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({}) });
    await refused(fetchMock);

    await click('admin-equipment-different-asset');
    const submit = q<HTMLButtonElement>('admin-equipment-override-submit')!;
    setValue('admin-equipment-override-reason', 'new one');
    expect(submit.disabled).toBe(true);

    setValue('admin-equipment-override-reason', 'Different VIN — the Wabash, not the Fruehauf');
    expect(submit.disabled).toBe(false);
    await click('admin-equipment-override-submit');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchMock, 1)).toMatchObject({
      assetType: 'trailer',
      unitNumber: '5327',
      confirmDistinct: {
        reason: 'Different VIN — the Wabash, not the Fruehauf',
        distinctFromIds: ['eq-1', 'eq-2'],
      },
    });
    expect(push).toHaveBeenCalled();
  });

  it('override_incomplete (the fleet changed) re-offers the override over the NEW list', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(refusal('probable_duplicate', [ROW('eq-1')]))
      .mockResolvedValueOnce(refusal('override_incomplete', [ROW('eq-1'), ROW('eq-9')]))
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({}) });
    await refused(fetchMock);
    await click('admin-equipment-different-asset');
    setValue('admin-equipment-override-reason', 'Different VIN on the plate');
    await click('admin-equipment-override-submit');

    expect(q('admin-equipment-similar-eq-9')).not.toBeNull();
    await click('admin-equipment-different-asset');
    setValue('admin-equipment-override-reason', 'Different VIN on the plate');
    await click('admin-equipment-override-submit');
    expect(
      (bodyOf(fetchMock, 2)['confirmDistinct'] as { distinctFromIds: string[] }).distinctFromIds,
    ).toEqual(['eq-1', 'eq-9']);
  });

  it('"Use this one" fires onUseExisting; an INACTIVE match reads "Reactivate and use"', async () => {
    const onUseExisting = vi.fn();
    await refused(
      vi
        .fn()
        .mockResolvedValueOnce(
          refusal('probable_duplicate', [ROW('eq-1'), ROW('eq-2', { isActive: false })]),
        ),
      onUseExisting,
    );
    expect(q('admin-equipment-use-existing-eq-2')!.textContent).toContain('Reactivate');
    await click('admin-equipment-use-existing-eq-1');
    expect(onUseExisting).toHaveBeenCalledWith('eq-1', true);
  });

  it('a merged match is shown but never offered', async () => {
    await refused(
      vi
        .fn()
        .mockResolvedValueOnce(refusal('probable_duplicate', [ROW('eq-1', { mergedIntoId: 'x' })])),
      vi.fn(),
    );
    expect(q('admin-equipment-similar-eq-1')).not.toBeNull();
    expect(q('admin-equipment-use-existing-eq-1')).toBeNull();
  });

  it('editing a field drops the stale refusal', async () => {
    await refused(vi.fn().mockResolvedValueOnce(refusal('probable_duplicate', EXISTING)));
    setValue('admin-equipment-create-unit', '5328');
    expect(q('admin-equipment-similar')).toBeNull();
  });
});

describe('409 name_taken / vin_taken — NOT overridable', () => {
  it.each(['name_taken', 'vin_taken'])('%s offers "Use this one" but no override', async (code) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(refusal(code, [ROW('eq-1')])));
    mount(<EquipmentCreateForm sites={SITES} onUseExisting={vi.fn()} />);
    fillTrailer();
    await click('admin-equipment-create-submit');
    expect(q('admin-equipment-use-existing-eq-1')).not.toBeNull();
    expect(q('admin-equipment-different-asset')).toBeNull();
    expect(errorText()).toContain(code);
  });

  it('without onUseExisting the matches are read-only', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(refusal('name_taken', [ROW('eq-1')])));
    mount(<EquipmentCreateForm sites={SITES} />);
    fillTrailer();
    await click('admin-equipment-create-submit');
    expect(q('admin-equipment-similar-eq-1')).not.toBeNull();
    expect(q('admin-equipment-use-existing-eq-1')).toBeNull();
  });

  it('a 409 with NO candidates falls back to the plain banner', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(refusal('name_taken', [])));
    mount(<EquipmentCreateForm sites={SITES} onUseExisting={vi.fn()} />);
    fillTrailer();
    await click('admin-equipment-create-submit');
    expect(q('admin-equipment-similar')).toBeNull();
    expect(errorText()).toContain('name_taken');
  });
});

describe('"already in the fleet?" lookup', () => {
  const wait = (ms: number) =>
    act(async () => {
      await new Promise((r) => setTimeout(r, ms));
    });

  it('queries the similar endpoint with the GENERATED name, unit, vin and type (no search=1)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ existing: [ROW('eq-1')] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    mount(
      <EquipmentCreateForm
        sites={SITES}
        similarEndpoint="/api/admin/equipment/similar"
        onUseExisting={vi.fn()}
      />,
    );
    fillTrailer('5327');
    await wait(450);

    const url = String(fetchMock.mock.calls.at(-1)?.[0]);
    const params = new URL(url, 'http://x').searchParams;
    expect(url.startsWith('/api/admin/equipment/similar?')).toBe(true);
    expect(params.get('q')).toBe('5327 — Trailer');
    expect(params.get('unit')).toBe('5327');
    expect(params.get('type')).toBe('Trailer');
    expect(params.has('search')).toBe(false);
    expect(q('admin-equipment-similar-eq-1')).not.toBeNull();
    // A passive hint is never an override prompt — only a server refusal is.
    expect(q('admin-equipment-different-asset')).toBeNull();
  });

  it('issues no lookup without a similar endpoint', async () => {
    const fetchMock = okFetch();
    mount(<EquipmentCreateForm sites={SITES} />);
    fillTrailer();
    await wait(450);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
