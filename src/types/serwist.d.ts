// Type augmentation for the Serwist Service Worker entry at
// `src/app/sw.ts`. The build-time precache manifest is injected by
// `@serwist/next` as the `__SW_MANIFEST` global; declaring it here
// keeps `tsc --noEmit` quiet during typecheck without polluting the
// runtime bundle.

declare global {
  interface ServiceWorkerGlobalScope {
    __SW_MANIFEST: (import('serwist').PrecacheEntry | string)[] | undefined;
  }
}

export {};
