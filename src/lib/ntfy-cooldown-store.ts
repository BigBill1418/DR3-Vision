// Re-export of the ONE durable ntfy cooldown ledger (ADR-0130).
//
// The implementation lives at `./mymrc/cooldown-store` because
// `tsconfig.mymrc.json` pins `rootDir: ./src/lib/mymrc` and the alias-less MyMRC
// bundle cannot import above it. This file is the app-facing name so nothing
// outside mymrc needs to know about that build-system detail — exactly the shape
// `src/lib/ntfy-header-safe.ts` already uses for the header sanitizer (ADR-0019.5).

export {
  claimCooldown,
  releaseCooldown,
  setCooldownDb,
  hasCooldownDb,
  __cooldownTesting,
  type CooldownDb,
  type CooldownClaim,
} from './mymrc/cooldown-store';
