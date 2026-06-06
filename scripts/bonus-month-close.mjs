// Bonus month-close cron (ADR-0019 §2 + §5a, T-125).
//
// Schedule (fleet deployer cron surface, NOT a system crontab):
//   5 0 1 * *   TZ=America/Los_Angeles   node scripts/bonus-month-close.mjs
// i.e. 00:05 Pacific on the 1st of each month — just after the prior month ends.
//
// It POSTs the internal, loopback-guarded close endpoint, which transitions every
// draft month whose month has ended to `pending_signatures` (via the audited state
// machine) and emails the facility-manager signer for each (signature-request).
// Keeping the logic behind the Next route avoids re-implementing the state machine
// in plain Node (the .mjs cannot import the TypeScript modules).

const BASE = process.env.INTERNAL_BASE_URL ?? 'http://127.0.0.1:3000';
const TOKEN = process.env.INTERNAL_CRON_TOKEN ?? '';

const headers = { 'content-type': 'application/json' };
if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;

try {
  const res = await fetch(`${BASE}/api/internal/bonus/close-months`, {
    method: 'POST',
    headers,
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`[bonus-month-close] HTTP ${res.status}: ${text}`);
    process.exit(1);
  }
  console.log(`[bonus-month-close] ${text}`);
} catch (err) {
  console.error('[bonus-month-close] request failed:', err?.message ?? err);
  process.exit(1);
}
