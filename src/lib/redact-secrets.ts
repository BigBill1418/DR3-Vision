// Re-export of the ONE secret redactor for caught-error text (ADR-0133).
//
// The implementation lives at `./mymrc/redact-secrets` because
// `tsconfig.mymrc.json` pins `rootDir: ./src/lib/mymrc` and the alias-less MyMRC
// bundle cannot import above it. This file is the app-facing name so nothing
// outside mymrc needs to know about that build-system detail — exactly the shape
// `src/lib/ntfy-header-safe.ts` (ADR-0019.5) and `src/lib/ntfy-cooldown-store.ts`
// (ADR-0130) already use.

export { redactSecrets, REDACTED, REDACTION_PATTERNS } from './mymrc/redact-secrets';
