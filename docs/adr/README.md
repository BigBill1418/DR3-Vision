# Architecture Decision Records (ADRs)

This directory contains short, dated, immutable records of the technical and architectural decisions made on DR3-Vision. Read every ADR before writing code; they encode constraints that are not always obvious from the codebase.

## Index

| #      | Title                                                                                                       | Status                                                          |
| ------ | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 0001   | Tech stack                                                                                                  | Accepted                                                        |
| 0002   | Fleet host                                                                                                  | Accepted                                                        |
| 0003   | Domain & routing                                                                                            | Accepted                                                        |
| 0004   | PIN authentication                                                                                          | Accepted                                                        |
| 0005   | Photo storage & retention                                                                                   | Accepted                                                        |
| 0006   | Offline queue strategy                                                                                      | Accepted                                                        |
| 0007   | Audit log design & retention                                                                                | Accepted                                                        |
| 0008   | Brand theme                                                                                                 | Accepted                                                        |
| 0009   | MyMRC integration via Playwright                                                                            | Accepted (with deferred reconsideration on API access)          |
| 0010   | CIP data handling                                                                                           | Deferred (V2.2 scope)                                           |
| 0011   | Processor Form / deconstruction-line workflow                                                               | Accepted (V2.1 scope) — bonus formula superseded by ADR-0019 §1 |
| 0012   | Sprint-1 clarifications and supplements                                                                     | Accepted                                                        |
| 0013   | Production deploy pattern                                                                                   | Accepted                                                        |
| 0014   | Canonical brand mark + dark-mode auth surfaces                                                              | Accepted                                                        |
| 0015   | i18n architecture — server dictionaries + client React Context                                              | Accepted                                                        |
| 0016   | Entra ID SSO-only for managers + admins; email+password removed                                             | Accepted                                                        |
| 0017   | Admin Settings panel for user seeding & management                                                          | Accepted                                                        |
| 0018   | Audit log viewer (`/admin/audit`)                                                                           | Accepted                                                        |
| 0019   | Bonus Management System (extends ADR-0011; §3 delivery via ADR-0021; surfaced on ADR-0020 dashboard)        | Accepted                                                        |
| 0019.1 | Bonus cadence — bi-weekly pay periods + signature timing (Sprint-2 addendum; extends 0019)                  | Accepted                                                        |
| 0019.2 | Bonus Eugene site enablement (Sprint-2 addendum; extends 0019, 0019.1)                                      | Accepted                                                        |
| 0020   | Vision Dashboard tile landing (features Bonus Management per ADR-0019)                                      | Accepted                                                        |
| 0021   | M365 Graph mail-send for payroll PDF delivery (extends ADR-0016; delivers ADR-0019 PDFs)                    | Accepted                                                        |
| 0022   | Fleet observability wire-in — GlitchTip, Loki, Tempo, Grafana, Prometheus, ntfy (supersedes T-018 deferral) | Accepted                                                        |

## How to write a new ADR

1. Number it sequentially (`0012-...`), dated (`2026-MM-DD`), short title.
2. Use the template:
   - **Context** — what's the situation
   - **Decision** — what we chose
   - **Alternatives considered** — what we rejected and why
   - **Consequences** — what this commits us to
3. Once accepted, ADRs are immutable. To overturn one, write a new ADR that supersedes it.
4. Cross-reference the charter section that prompted the decision.
