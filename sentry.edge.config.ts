// Sentry/GlitchTip edge-runtime init (ADR-0022 §2).
// We don't currently use the edge runtime for application logic (middleware is
// auth-only), but the SDK expects this file. No-ops cleanly without a DSN.
import * as Sentry from '@sentry/nextjs';
import { glitchTipInitOptions } from '@/lib/observability/sentry';

const options = glitchTipInitOptions();
if (options) {
  Sentry.init(options);
}
