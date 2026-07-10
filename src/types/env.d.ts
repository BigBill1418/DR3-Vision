// Deploy-identity env vars, declared so DOTTED access is legal under
// `noPropertyAccessFromIndexSignature`. This is load-bearing, not cosmetic:
// next.config.js inlines DR3_BUILD_SHA/DR3_BUILD_AT via webpack DefinePlugin,
// which rewrites ONLY dotted `process.env.X` — bracket access is left as a
// runtime lookup that finds nothing (the values exist solely at build time).
// That gap made every prod log line, OTel trace, and boot alert report
// version "dev" while the baked .build-info.json carried the real sha.
declare namespace NodeJS {
  interface ProcessEnv {
    /** Real git sha, baked into .build-info.json at image build (Dockerfile). */
    DR3_BUILD_SHA?: string;
    /** Image build timestamp (ISO), same source. */
    DR3_BUILD_AT?: string;
    /** Optional operator override; wins over the baked sha when set. */
    GIT_SHA?: string;
  }
}
