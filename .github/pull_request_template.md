<!-- DR3-Vision PR template -->

## Summary

<!-- What changed and why. Link the ADR / ticket. -->

## Checklist

- [ ] Tests pass (`npm test`) and types/lint are clean (tsc 0, eslint 0).
- [ ] Migrations (if any) clean-replay on an empty PG16 (ADR-0035).
- [ ] Docs updated (CHANGELOG + ADR/operator doc as applicable).

## Staff-output rollout gate (ADR-0047) — REQUIRED

- [ ] This change does **not** add or expand staff-visible output (email/ntfy,
      new recipient rosters, new dashboards/UI surfaces linked from emails).
- [ ] **OR** it does, and it ships **pilot**: it routes staff mail through
      `notifyStaff()` (no raw `@/lib/m365-mail` import), registers a
      `rollout_surfaces` row (born pilot), and is ramped only by Bill from
      `/admin/rollout`. Recipient rosters named here are the EVENTUAL audience,
      never day-one.
