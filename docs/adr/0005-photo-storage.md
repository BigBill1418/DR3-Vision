# ADR-0005: Photo storage & retention

**Date:** 2026-05-04
**Status:** Accepted

## Context

Every inbound load captures multiple photos: BOL, optional weight ticket, door-open, optional concern photos, optional rejection photos. Photos can be annotated by the operator (circle, arrow, freehand, text); both raw and annotated versions are retained.

At ~10 photos × ~50,000 loads/year × ~2MB/photo, the dataset grows by ~1TB/year. We cannot store this in Postgres (would saturate the fleet host's local disk in months).

Photo retention requirements vary by jurisdiction:
- **California (Woodland):** 4 years (CA contract Article 12)
- **Oregon (Eugene):** 5 years (OR contract Article 12)

Photos are evidence in MRC reconciliation disputes and contract audits.

## Decision

Photos are stored in **Cloudflare R2** with signed URLs.

### Architecture
- The iPad never authenticates to R2 directly. Photos POST to the application server, which generates a signed PUT URL, uploads, and persists the storage key.
- The application server signs GET URLs with short-lived expirations (15 minutes) when serving photos to the manager portal.
- Both raw and annotated versions are stored as separate R2 objects: `<load_id>/<kind>/raw.jpg` and `<load_id>/<kind>/annotated.jpg`.
- The `load_photos` table links to both via `storage_key` and `annotation_storage_key` (nullable).

### Retention
- A scheduled job runs nightly: identifies photos older than the per-program retention window (CA 4yr / OR 5yr) and removes the R2 object plus marks the `load_photos` row as `purged_at`.
- The audit log row for the purge captures who/what/when (the scheduler is a system actor).
- The `load_photos` row is preserved with metadata even after the photo bytes are purged — only the R2 object is removed.

### Format
- JPEG at iPad-native resolution; we do not re-encode on capture.
- Annotated overlay rendered to a separate JPEG to preserve the original.
- EXIF metadata stripped on upload (privacy + size).

## Alternatives considered

- **Postgres BYTEA** — would saturate the fleet host's local disk and ruin database backup performance.
- **Local fleet host disk** — same problem.
- **AWS S3** — egress fees become significant when managers review many photos. R2 has zero egress.
- **Permanent retention** — defies California's 4-year limit (we are *required* to be able to delete on request) and adds unbounded storage cost.

## Consequences

- A single point of failure: R2 outage means new photos cannot be uploaded. The offline queue holds them locally on the iPad until R2 returns. (See ADR-0006.)
- Photo loss is a hard-failure scenario; we mitigate with R2's multi-region replication (default for R2 buckets) and by retaining the operator-generated photos in IndexedDB until the server confirms upload.
- Per-program retention requires the scheduled purge job to know which contract applies to each photo. The `load_photos.site_id → sites.jurisdiction` lookup drives this.

## References

- Charter §5.5 (Photo handling), §6.5 (R2 schema)
- CA Contract Article 12, OR Contract Article 12
