// Sentry/GlitchTip server-runtime init (ADR-0022 §2).
// Loaded by `instrumentation.ts` register() on the Node.js runtime.
// No-ops cleanly when GLITCHTIP_DSN is unset (fail-open).
import * as Sentry from '@sentry/nextjs';
import { glitchTipInitOptions } from '@/lib/observability/sentry';

const options = glitchTipInitOptions();
if (options) {
  Sentry.init(options);
}
