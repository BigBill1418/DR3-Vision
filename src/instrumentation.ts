// Next.js instrumentation hook (Node runtime only).
//
// Two side-effects on first server boot:
//   1. Publish `[DR3-Vision] Container started` to `dr3-vision-container`
//      (ADR-0036 + ADR-0037, 30-min cooldown so a crashloop doesn't
//      spam Bill's phone).
//   2. Wire `process.on('uncaughtException')` and `unhandledRejection`
//      to publish `[DR3-Vision] Unhandled error: <summary>` with a
//      30-min per-fingerprint cooldown.
//
// The hook is invoked once per Node.js process — Next.js standalone
// boot, dev server, and Vitest workers all hit this. We guard against
// running in the edge runtime (where `process` doesn't have signal
// hooks) and against the dev-mode HMR re-instantiation that would
// otherwise stack handlers.
//
// Per CLAUDE.md hard rule #5 + docs/COMPLIANCE.md, these are the only
// two system-level publish paths the app emits. Operational alerts
// (rejections, long unloads, SLA breaches, PIN lockouts) stay on the
// in-app dashboard and never page.

export async function register(): Promise<void> {
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') {
    // Edge runtime — middleware bundle, etc. ntfy publish needs Node
    // crypto + native fetch with AbortController; skip cleanly.
    return;
  }

  // Lazy import so the helper only loads on the Node side.
  const { publishContainerStart, publishUnhandledError } = await import('@/lib/ntfy');

  // Boot publish — fire-and-forget. The promise resolves when ntfy
  // returns or the cooldown short-circuits; we don't await it because
  // the request handler should not block on a network call to a
  // separate host during cold-start.
  const version = process.env['npm_package_version'] ?? '0.1.0';
  const commitSha = process.env['DR3_GIT_COMMIT_SHA'] ?? process.env['VERCEL_GIT_COMMIT_SHA'];
  void publishContainerStart({ version, commitSha });

  // Idempotency guard — Next.js dev mode re-runs `register` per HMR
  // event. Without this guard we'd accumulate handlers and double-page
  // every uncaught error.
  const g = globalThis as unknown as { __dr3VisionNtfyHandlersWired?: boolean };
  if (g.__dr3VisionNtfyHandlersWired) return;
  g.__dr3VisionNtfyHandlersWired = true;

  process.on('uncaughtException', (err) => {
    void publishUnhandledError({ err, context: 'uncaughtException' });
  });
  process.on('unhandledRejection', (reason) => {
    void publishUnhandledError({ err: reason, context: 'unhandledRejection' });
  });
}
