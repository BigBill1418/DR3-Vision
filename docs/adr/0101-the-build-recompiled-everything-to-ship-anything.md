# ADR-0101 — The build recompiled everything to ship anything

**Date:** 2026-08-12 (Pacific)
**Status:** Accepted, implemented 2026-08-12

## Context

Every DR3-Vision deploy costs about **17 minutes**, and roughly **853 s** of that
is `docker compose build` on CHAD-HQ. That number does not depend on the size of
the change: a one-line comment and a thousand-line feature cost the same, because
the expensive step is not incremental.

A read-only investigation on 2026-08-12 (Terry) established the shape, and each
load-bearing claim below was re-verified against the host before anything was
edited.

**The Docker layer cache is not broken.** That was the first hypothesis and it is
wrong. The deployer runs a plain `docker compose build` with no `--no-cache`, and
layers do get reused. The cost is structural:

```
COPY . .            ← changes on EVERY commit
...
RUN npm run build   ← therefore re-executes on EVERY commit
```

`RUN npm run build` sits below `COPY . .`, so its layer is invalidated by any
commit whatsoever. It then compiles **93 pages, 191 API routes, ~266k LOC** from
a cold start — about **787 s of the 853 s**.

It starts cold every time because nothing carries the compiler cache between
builds. Next.js keeps that cache in `.next/cache` — *"Next.js saves a cache to
`.next/cache` that is shared between builds"* (Next.js CI build-caching docs) —
and this repo's `.dockerignore` excludes `.next`, correctly, so no host-built
cache enters the context. With no BuildKit cache mount either, every single build
began from an empty compiler cache.

**A second, smaller cost sits on top of the first.** CHAD-HQ runs
`buildkit-prune-daily` (systemd timer, 04:30 UTC,
`/opt/maintenance/buildkit-prune-daily.sh`, an ADR-0062 §2 artifact in
`noc-master`) with `--keep-storage=4GB`. The 2026-08-12 04:31 run is in
`/var/log/buildkit-prune.log`: it **deleted 12.63 GB and left 5.166 GB**. That
evicts the `npm ci` layer, so the first build of each day pays an extra
**~200–270 s** reinstall tail on top of the compile.

The deploy budget makes this more than an annoyance. `compose_build_timeout` for
this repo is **1500 s** — raised from the 600 s global default after a cold build
was SIGKILL'd at the cap on 2026-06-09 and the new code silently did not land.
An 853 s build sits at ~57% of that ceiling, and it grows with the codebase.

## Decision

Persist both caches across builds with BuildKit cache mounts, and stop the
nightly prune from evicting them.

**1. The npm download cache.**

```dockerfile
RUN --mount=type=cache,id=dr3-npm,target=/root/.npm npm ci
```

**2. The Next.js compiler cache — the expensive one.**

```dockerfile
RUN --mount=type=cache,id=dr3-next-cache,target=/app/.next/cache,sharing=locked npm run build
```

**3. CHAD-HQ prune retention: 4 GB → 40 GB.** The host is at 6% of 4.9 TB with
4.4 TB free; the entire build cache measured 13.88 GB. The daily prune still
runs and still bounds the working set — it simply stops throwing away the thing
that makes the build fast. The flag also moves from `--keep-storage` to
`--reserved-space`: Docker 29.3.1 answers the old spelling with *"Flag
--keep-storage has been deprecated, keep-storage flag has been changed to
reserved-space"*, and since the script runs under `set -euo pipefail`, the day
that alias is removed the whole prune dies silently.

**4. The dead `deps` stage is removed.** Nothing ever copied from it —
`--from=deps` appears nowhere and compose sets no build `target:` — so BuildKit
never built it. Its removal buys no time; it removes a thing that reads like it
matters and does not.

**Type-checking stays inside the image build.** This is Bill's explicit call and
it is the right one: `npm run build` is what produces the artifact that ships, and
the type gate is the one that would have caught the `total_payout_cents` type-lie
that zeroed the 2026-06-22 sign-time payout lock (ADR-0033). CI type-checks the
*commit*; this type-checks the *image*.

### What was verified, and how

| Claim | Evidence |
| --- | --- |
| `/app/.next/cache` is the right target | `WORKDIR /app` in the builder stage; `next.config.js` sets no `distDir`; `output: 'standalone'` |
| Cache mounts work with **no** `# syntax=` directive | Throwaway build on CHAD-HQ printed `MOUNT_A_OK` / `MOUNT_B_OK`, exit 0. So the built-in frontend suffices and no `docker/dockerfile:1` pull is added to every build |
| The edited Dockerfile is valid | `docker build --check` on CHAD-HQ: *"Check complete, no warnings found."* |
| Mounts are observable | `docker builder du --verbose` reports `cached mount <target> … with id "…"` |
| The `deps` stage is dead | No `--from=deps`, no `target:` in `docker-compose.yml`, no reference in CI |
| Baseline before the change | `docker builder du` total **13.88 GB**, **zero** cache-mount records (2026-08-12 10:44 UTC) |

`id=` is set explicitly on both mounts because CHAD-HQ is a ~15-tenant host. An
unnamed mount takes an id derived from its target path, so every other stack's
`/root/.npm` — and, worse, any other Next app's `.next/cache` — would share one
directory. `sharing=locked` serializes concurrent builds rather than letting two
writers interleave into the same cache.

Nothing `COPY`s `.next/cache` into the runner stage, so this is a **build-time
change with no runtime surface**.

## Alternatives considered

**Move type-checking to CI and drop it from the image build.** Declined by Bill,
and correctly. CI already type-checks every push; removing the gate from the
image build would make the artifact that actually ships the one thing never
checked. The saving is also smaller than it looks — the compile dominates.

**Cache `node_modules` directly instead of `/root/.npm`.** Rejected. `npm ci`
deletes and recreates `node_modules` by design; a cache mount there fights the
tool and can leave a partially-populated tree that npm treats as authoritative.
`/root/.npm` is the content-addressed tarball cache npm is built to reuse.

**Stop excluding `.next` from the build context so a host-built cache carries
in.** Rejected. It bakes a host-built artifact into an image layer, is not
reproducible across hosts, and inflates the context on every build. The whole
point of a cache mount is that the cache is *not* part of the image.

**Disable the nightly prune.** Rejected. `noc-master` ADR-0062 §2 exists because
dockerd's working set drifts over multi-day uptime. Raising the reserve keeps the
bound while ending the eviction.

**Pin `# syntax=docker/dockerfile:1`.** Rejected on evidence: the host's built-in
frontend already supports these mounts, so the directive would add a network
image pull to every build in exchange for nothing.

## Consequences

- **This deploy is still a full cold build.** The mounts have nothing in them
  until a build populates them. The first build after this change pays the usual
  ~17 minutes; that was understood and approved before shipping.
- **The measurable win lands on the following deploy.** The expectation is the
  compile step drops from ~787 s to a fraction of it, taking the build well below
  half. That number gets read off the next deploy's timing, not asserted here —
  an expectation is not a measurement.
- **Cache mounts are host state, not image state.** A build on a different host,
  or after `docker builder prune --all`, starts cold again. A cold build with
  these mounts is no slower than a cold build without them, so the floor is
  unchanged; only the ceiling moves.
- **The nightly prune at 40 GB stops evicting the mounts** at current volumes
  (13.88 GB of total build cache measured against a 40 GB reserve).
- **Deleting a `--mount` flag silently restores the slow build.** Nothing fails;
  the build just gets long again. The Dockerfile comments say so at both call
  sites, which is the only guard available for a performance property.
- **The host script change is recorded in two places.** The prune script belongs
  to `noc-master` ADR-0062 §2, so the retention change is written into that ADR
  and that CHANGELOG as well as this one. A host edit recorded only in the repo
  it happened to help is a host edit nobody finds later.
