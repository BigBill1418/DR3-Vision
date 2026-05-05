# ADR-0004: PIN authentication

**Date:** 2026-05-04
**Status:** Accepted

## Context

Operators are forklift drivers wearing gloves. The iPad is shared across operators per shift. Operators must be unambiguously attributed to each load (legal/audit requirement) but cannot reasonably type email + password.

Most warehouse-floor systems use shared accounts or shared logins. This is unacceptable here because every load record must trace to an individual operator.

## Decision

Operator authentication uses **per-user 4-digit PINs**, hashed with **Argon2id**.

Login UI: name picker (operators tap their name) → numeric keypad → PIN entry.

### Policy
- 4 digits, numeric
- Disallow obvious patterns at create/change time: sequential (1234, 4321, 2345), all-same (0000, 1111), repeated-pair (1212, 3434)
- Unique within a site; reusable across sites (an Eugene PIN and a Woodland PIN can match — they have separate audit trails)
- Manager-resettable for users at their site; admin-resettable for any user; reset action audit-logged with actor, target, timestamp
- Server-side rate limit: **5 failed attempts in 60 seconds → 15-minute auto-unlock lockout**
- Repeat-lockout indicator surfaces on the Compliance dashboard so managers can spot training issues

### Storage
- `pin_hash` column on `users`, **not indexed** (preventing PIN enumeration)
- PINs never logged
- PINs never stored client-side; the iPad sends a freshly-typed PIN on every authentication

### Sessions
- Auto-logout on every load submission, after 5 minutes idle, on explicit "Switch user"
- Session cookie scoped to operator role; cannot escalate to manager/admin via cookie manipulation

## Alternatives considered

- **6-digit PINs** — stronger entropy, but the friction cost on a forklift mount (gloves, glare, cold) outweighs the security gain given rate limiting plus 5-attempt lockout. Banks default to 4 digits.
- **Biometric (Face ID/Touch ID)** — iPad sharing across operators per shift breaks biometric model; one operator's enrollment isn't transferable.
- **Shared account, audit by who-was-on-shift** — defeats per-load operator attribution which both contracts require.
- **Email + password on iPad** — too slow, too error-prone with gloves.
- **Tap-card / RFID badge** — operations doesn't have badges; operators don't carry them.

## Consequences

- 10,000 PIN combinations per site per user means brute force is bounded; with 5 attempts per 15 minutes, an attacker would average ~5,000 × 15min = ~52 days of constant attempts to find one PIN, easily detected.
- A forgotten PIN is a manager problem, not a self-serve flow. The repeat-lockout indicator is the early warning.
- Audit log captures the operator user_id, not the PIN. PIN values never appear in logs, dashboards, or exports.

## References

- Charter §5.1 (Security), §5.4 (Authentication)
- Q21 in charter v0.29 changelog (final policy lock)
