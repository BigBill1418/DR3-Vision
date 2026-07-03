// ADR-0039 — comparator barrel. One pure function per check (C1–C7); each takes
// date-windowed legs + a `CheckConfig` and returns typed `Finding[]`. No
// comparator reads a DB or a clock — everything is passed in.

export { c1Inbound } from './c1-inbound';
export { c2Processed } from './c2-processed';
export { c3Outbound, type C3LegA } from './c3-outbound';
export { c4BillingBasis, sumProgramUnitsProcessed } from './c4-billing';
export { c5Conservation } from './c5-conservation';
export { c6InventoryContinuity } from './c6-inventory';
export { c7Deadline, type C7Input } from './c7-deadline';
