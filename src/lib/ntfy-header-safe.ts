// Re-export of the ONE ntfy header sanitizer.
//
// The implementation lives at `./mymrc/header-safe` because
// `tsconfig.mymrc.json` pins `rootDir: ./src/lib/mymrc` and the mymrc bundle
// cannot import above it. This file is the app-facing name so nothing outside
// mymrc needs to know about that build-system detail. See ADR-0019.5.

export { toHeaderSafe } from './mymrc/header-safe';
