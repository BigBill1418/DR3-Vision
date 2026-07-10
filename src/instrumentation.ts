// Next.js instrumentation hook (ADR-0036/0037 ntfy + ADR-0022 observability).
//
// Side-effects on first server boot, in order:
//   1. (Node) GlitchTip/Sentry server-runtime init — error reporting (ADR-0022 §2).
//   2. (Node) OpenTelemetry NodeSDK — traces to Tempo (ADR-0022 §1), gated on
//      TEMPO_ENDPOINT so it no-ops cleanly in dev / when unset (fail-open).
//   3. (Node) Publish `[DR3-Vision] Container started` to `dr3-vision-container`
//      (30-min cooldown so a crashloop doesn't spam Bill's phone).
//   4. (Node) Wire `uncaughtException` / `unhandledRejection` → ntfy publish with a
//      30-min per-fingerprint cooldown. (GlitchTip captures these too; the two
//      gate independently per ADR-0022 §2.)
//   5. (Edge) GlitchTip/Sentry edge-runtime init.
//
// The hook is invoked once per Node.js process. We guard the edge runtime (no
// signal hooks there) and dev-mode HMR re-instantiation (which would stack
// handlers).
//
// All observability is FAIL-OPEN (SPRINT-2-HANDOFF hard rule #6): no TEMPO_ENDPOINT
// → no traces; no GLITCHTIP_DSN → no error reporting; no NTFY token → no pages.
// The app starts and serves regardless.

export async function register(): Promise<void> {
  const runtime = process.env['NEXT_RUNTIME'];

  if (runtime === 'edge') {
    // Edge bundle (middleware). ntfy + OTel NodeSDK need Node APIs; only the
    // Sentry edge init is safe here.
    await import('../sentry.edge.config');
    return;
  }

  if (runtime !== 'nodejs') return;

  // ─── GlitchTip/Sentry (errors) ─────────────────────────────────────────
  await import('../sentry.server.config');

  // ─── OpenTelemetry (traces → Tempo) ────────────────────────────────────
  await initOpenTelemetry();

  // ─── ntfy boot publish + uncaught handlers (existing behavior) ──────────
  const { publishContainerStart, publishUnhandledError } = await import('@/lib/ntfy');

  // Boot publish — fire-and-forget; cold-start request handling must not block
  // on a network call to a separate host.
  // Deploy identity baked at image build (never package.json's scaffold 0.1.0).
  const { buildInfo, shortSha } = await import('@/lib/build-info');
  void publishContainerStart({ version: `built ${buildInfo().builtAt}`, commitSha: shortSha() });

  // Idempotency guard — Next.js dev mode re-runs `register` per HMR event.
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

// ───────────────────────────────────────────────────────────────────────────
// Next.js server-error hook → GlitchTip. Next 15 calls this for errors thrown in
// nested React Server Components, route handlers, and server actions that the
// default boundary wouldn't otherwise report to the SDK.
// ───────────────────────────────────────────────────────────────────────────
export async function onRequestError(
  ...args: Parameters<NonNullable<typeof import('@sentry/nextjs').captureRequestError>>
): Promise<void> {
  if (!process.env['GLITCHTIP_DSN']) return;
  const Sentry = await import('@sentry/nextjs');
  Sentry.captureRequestError(...args);
}

// ───────────────────────────────────────────────────────────────────────────
// OpenTelemetry NodeSDK init. Idempotent within a process; fail-open on missing
// TEMPO_ENDPOINT. Sampling: 100% in dev, OTEL_TRACE_SAMPLE_RATE (default 1%) in
// production via a ParentBased(TraceIdRatioBased) head sampler.
//
// NOTE (honest residual): ADR-0022 §1 also wants "100% error spans". Always
// retaining error spans is a TAIL-sampling concern (the error isn't known at span
// start), handled at the OTel Collector — not expressible in a head sampler. This
// implements the ratio head sampler; collector-side tail sampling for errors is a
// fleet-collector follow-up, not wired here.
// ───────────────────────────────────────────────────────────────────────────
async function initOpenTelemetry(): Promise<void> {
  const endpoint = process.env['TEMPO_ENDPOINT'];
  if (!endpoint) {
    console.log('[observability] TEMPO_ENDPOINT not set, tracing disabled');
    return;
  }

  const g = globalThis as unknown as { __dr3VisionOtelStarted?: boolean };
  if (g.__dr3VisionOtelStarted) return;
  g.__dr3VisionOtelStarted = true;

  // `webpackIgnore: true` — keep webpack from bundling the OTel tree on EITHER
  // server runtime. On nodejs these resolve from node_modules at runtime (the
  // only place this code runs); on edge the whole function is unreachable
  // (guarded above) so the imports never execute. This avoids both the node-build
  // gRPC/native bundling failures and the edge "Native module not found" error.
  const { NodeSDK } = await import(/* webpackIgnore: true */ '@opentelemetry/sdk-node');
  const { OTLPTraceExporter } = await import(
    /* webpackIgnore: true */ '@opentelemetry/exporter-trace-otlp-http'
  );
  const { getNodeAutoInstrumentations } = await import(
    /* webpackIgnore: true */ '@opentelemetry/auto-instrumentations-node'
  );
  const { resourceFromAttributes } = await import(
    /* webpackIgnore: true */ '@opentelemetry/resources'
  );
  const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = await import(
    /* webpackIgnore: true */ '@opentelemetry/semantic-conventions'
  );
  const { ParentBasedSampler, TraceIdRatioBasedSampler } = await import(
    /* webpackIgnore: true */ '@opentelemetry/sdk-trace-node'
  );

  const sampleRate =
    process.env['NODE_ENV'] === 'production'
      ? Number(process.env['OTEL_TRACE_SAMPLE_RATE'] ?? '0.01')
      : 1;

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: 'dr3-vision',
      // Single deploy-identity source (see build-info.ts — inlined sha).
      [ATTR_SERVICE_VERSION]: (await import('@/lib/build-info')).buildInfo().sha,
      'deployment.environment.name': process.env['NODE_ENV'] ?? 'development',
    }),
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(Number.isFinite(sampleRate) ? sampleRate : 0.01),
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false }, // too noisy
        '@opentelemetry/instrumentation-dns': { enabled: false }, // too noisy
      }),
    ],
  });

  sdk.start();
}
