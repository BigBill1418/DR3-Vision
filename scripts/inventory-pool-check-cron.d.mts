// Type surface for scripts/inventory-pool-check-cron.mjs (ADR-0143), for vitest.
export const TICK_MS: number;
export function truncateBody(text: string, max?: number): string;
export function runPoolCheckOnce(
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>,
  base?: string,
  token?: string,
): Promise<string>;
