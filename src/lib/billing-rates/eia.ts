// ADR-0040 D4 (Addendum B3) — EIA v2 weekly West-Coast diesel fetch.
//
// Fetches the EIA "Weekly West Coast (PADD 5) No 2 Diesel Ultra Low Sulfur Retail
// Prices" series via the v2 REST API. The equivalent legacy series id is
// `PET.EMD_EPD2DXL0_PTE_R50_DPG.W`; the v2 route + facets that select it are:
//
//   GET https://api.eia.gov/v2/petroleum/pri/gnd/data/
//       ?api_key=<KEY>
//       &frequency=weekly
//       &data[]=value
//       &facets[product][]=EPD2DXL0   (No 2 Diesel, Ultra Low Sulfur)
//       &facets[process][]=PTE        (retail, "prices to end users")
//       &facets[duoarea][]=R50        (PADD 5 / West Coast)
//       &sort[0][column]=period&sort[0][direction]=desc&length=<n>
//
// Response shape: { response: { data: [ { period: 'YYYY-MM-DD', value: <number>,
// units: 'DPGAL', ... }, ... ] } }. EIA stamps each weekly point on the Monday of
// its week, so `period` maps straight onto `fuel_prices.week_of`.
//
// FAIL-OPEN (ADR-0040 D4): the v2 API requires a key. When `EIA_API_KEY` is unset,
// or the request fails/returns nothing usable, this returns a typed non-throwing
// failure — the weekly cron logs it and skips (the manual-entry path still works),
// and the app NEVER crashes on a fuel fetch. The env var is documented in
// `docs/operator/billing-rates.md` and `.env.example`.

export const EIA_V2_DIESEL_URL = 'https://api.eia.gov/v2/petroleum/pri/gnd/data/';
export const EIA_DIESEL_FACETS = { product: 'EPD2DXL0', process: 'PTE', duoarea: 'R50' } as const;

/** A single normalized weekly diesel point: the week Monday + $/gal. */
export interface EiaWeeklyPrice {
  /** ISO `YYYY-MM-DD` — the Monday of the week (EIA's `period`). */
  weekOf: string;
  usdPerGal: number;
}

export type EiaFetchResult =
  | { ok: true; prices: EiaWeeklyPrice[] }
  | { ok: false; reason: 'no_api_key' | 'http_error' | 'bad_payload' | 'network_error'; detail: string };

export interface FetchEiaOptions {
  /** How many most-recent weekly points to request. Default 4. */
  length?: number;
  /** Inclusive lower bound `YYYY-MM-DD` (EIA `start`). Optional. */
  start?: string;
  /** Injectable for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to `process.env.EIA_API_KEY`. */
  apiKey?: string | undefined;
  /** Per-request timeout (ms). Default 10s. */
  timeoutMs?: number;
}

interface EiaV2Payload {
  response?: {
    data?: Array<{ period?: unknown; value?: unknown }>;
  };
}

/**
 * Fetch recent weekly West-Coast ULSD retail prices. Never throws — every failure
 * mode (missing key, non-2xx, malformed body, network error) collapses to a typed
 * `{ ok: false, reason, detail }` so the caller (the cron / internal route) can log
 * and skip without crashing.
 */
export async function fetchEiaWeeklyDiesel(opts: FetchEiaOptions = {}): Promise<EiaFetchResult> {
  const apiKey = opts.apiKey ?? process.env['EIA_API_KEY']?.trim();
  if (!apiKey) {
    return { ok: false, reason: 'no_api_key', detail: 'EIA_API_KEY is not set' };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const length = opts.length ?? 4;
  const url = new URL(EIA_V2_DIESEL_URL);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('frequency', 'weekly');
  url.searchParams.append('data[]', 'value');
  url.searchParams.append('facets[product][]', EIA_DIESEL_FACETS.product);
  url.searchParams.append('facets[process][]', EIA_DIESEL_FACETS.process);
  url.searchParams.append('facets[duoarea][]', EIA_DIESEL_FACETS.duoarea);
  url.searchParams.set('sort[0][column]', 'period');
  url.searchParams.set('sort[0][direction]', 'desc');
  url.searchParams.set('length', String(length));
  if (opts.start) url.searchParams.set('start', opts.start);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  let res: Response;
  try {
    res = await fetchImpl(url.toString(), { signal: controller.signal });
  } catch (e) {
    return { ok: false, reason: 'network_error', detail: errText(e) };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Body may carry an EIA error message, but never a secret — the key is a query
    // param we do not echo. Keep it short.
    const body = await res.text().catch(() => '');
    return { ok: false, reason: 'http_error', detail: `HTTP ${res.status}: ${body.slice(0, 200)}` };
  }

  let payload: EiaV2Payload;
  try {
    payload = (await res.json()) as EiaV2Payload;
  } catch (e) {
    return { ok: false, reason: 'bad_payload', detail: `json parse failed: ${errText(e)}` };
  }

  const rows = payload.response?.data;
  if (!Array.isArray(rows)) {
    return { ok: false, reason: 'bad_payload', detail: 'response.data is not an array' };
  }

  const prices: EiaWeeklyPrice[] = [];
  for (const row of rows) {
    const weekOf = typeof row.period === 'string' ? row.period.slice(0, 10) : null;
    const usdPerGal = toNumber(row.value);
    if (weekOf && /^\d{4}-\d{2}-\d{2}$/.test(weekOf) && usdPerGal != null) {
      prices.push({ weekOf, usdPerGal });
    }
  }
  if (prices.length === 0) {
    return { ok: false, reason: 'bad_payload', detail: 'no usable weekly price rows in response' };
  }
  return { ok: true, prices };
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
