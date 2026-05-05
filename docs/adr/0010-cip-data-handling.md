# ADR-0010: CIP data handling

**Date:** 2026-05-04
**Status:** Deferred (V2.2 scope)

## Context

The Consumer Incentive Program (CIP) is a California-only program where consumers can drop off a mattress or box spring and receive $3 per unit (max 5 units per vehicle per day) if their drop-off location is a participating recycler. Woodland is currently a CIP location.

CIP requires:
- Capturing the consumer's vehicle and identification at drop-off
- Counting units up to the daily 5-unit cap per vehicle
- Issuing the incentive payment
- Reporting CIP transactions back to MRC for reimbursement

The CA contract Article 6 governs CIP. Oregon does not have an equivalent program.

## Decision

CIP capture is **deferred to V2.2**.

MVP focuses on B2B inbound load tracking (transporter trucks delivering from collection sites). CIP is consumer-facing drop-off, a different workflow with different photo requirements, different identity capture, and different reimbursement reporting.

For MVP:
- The schema will allow a `load_source_type` enum (`b2b_haul`, `cip_consumer`) so the model is extensible, but only `b2b_haul` is implemented
- Operators will not see a CIP capture flow
- Woodland's CIP intake continues on whatever paper system it currently uses, parallel to DR3-Vision

## Alternatives considered

- **Build CIP into MVP** — would double the operator workflow surface area in Sprint 1, slow MVP shipping, and add complexity Bill explicitly wanted to avoid
- **Drop CIP from DR3-Vision entirely** — CIP is a meaningful revenue stream and a regulatory requirement; not building it eventually would mean keeping the paper process forever
- **Build a separate CIP-only tool** — duplicates user management, audit log, and dashboard infrastructure

## Consequences

- The `load_source_type` enum is in the MVP schema as a forward-compat hook
- V2.2 work to add CIP includes: consumer identity capture, vehicle photo, 5-unit daily cap enforcement per vehicle, CIP-specific exports, $3-per-unit incentive issuance flow
- CIP reconciliation against MRC uses the same machinery as B2B haul reconciliation, distinguished by `load_source_type`

## References

- Charter §1.4 (Consumer Incentive Program context)
- CA Contract Article 6 (CIP terms)
- Open decision in v0.30: V2.2 scope
