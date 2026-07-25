# Build Plan — iPad / floor surface i18n parity with the Vision main portal

**Date:** 2026-07-25
**Author:** Terry (research + design). Builder: aegis.
**ADR:** 0061 (this plan's decisions live in `docs/adr/0061-ipad-i18n-parity.md`)
**Driver (verbatim):** Bill — "make sure that all of the iPad surfaces are available in the same
languages that the Vision main portal is. this is critical."

---

## 0. TL;DR for the builder

The translations already exist and are in parity (en / es / ur, both `operator` and
`manager` namespaces — real-content keys match across all three; only inert `_meta._comment`
keys differ). The **post-authentication** iPad surfaces are fully wired to `useT()`/`translate()`
with correct RTL. **The problem is reachability, not missing strings:** a Spanish- or
Urdu-reading floor operator has no way to actually _get_ the iPad into their language, and the
sign-in screens they must read first are hard-forced to English. Four defects (D-1..D-4) plus a
parity-enforcement gap (D-5). This plan closes all five. **No auth/login logic changes** — the
parent is separately fixing the PIN-login bounce; this work only reads the session and adds a
locale control + persistence path.

---

## 1. Canonical locale set of the Vision MAIN portal (established from code)

**Authoritative source:** `src/i18n/config.ts`

- `LOCALES = ['en', 'es', 'ur']` (compile-time `as const`; the `Locale` type derives from it).
- `DEFAULT_LOCALE = 'en'`.
- `LOCALE_COOKIE = 'dr3_locale'`, 1-year TTL (`LOCALE_COOKIE_MAX_AGE_S`).
- RTL: `RTL_LOCALES = {'ur'}`; `isRtl()`, `dirFor()` → `'ltr' | 'rtl'`. Urdu is the only RTL.
- `LOCALE_LABELS = { en: 'English', es: 'Español', ur: 'اردو' }` — each written in its own
  script so a non-English reader can self-select.
- Mirrors the Prisma `UserLocale` enum (`schema.prisma:185`), `users.locale UserLocale @default(en)`.

The manager/desktop portal (`src/app/dashboard/layout.tsx`) and the operator/iPad shell
(`src/app/operator/layout.tsx`) BOTH consume the same `LOCALES` set through the same
`I18nProvider`. There is **no locale the main portal offers that the iPad config lacks** — the
config-level language set is already identical by construction. `/admin` is deliberately
English-only (ADR-0017) and out of scope.

**Message files (all present, all three locales):**
`src/i18n/locales/{en,es,ur}/operator.json` and `.../manager.json`.
`operator` = the iPad namespace; `manager` = the desktop dashboard namespace. Both share the
`I18nProvider` / `useT()` machinery in `src/i18n/provider.tsx`.

**RTL handling (already correct):**

- Root `src/app/layout.tsx:65` emits `<html lang={locale} dir={dirFor(locale)}>` — direction
  flows from the root for every route including the operator group.
- `src/app/operator/[site]/[userId]/keypad.tsx:73` forces `dir="ltr"` on the digit grid so PIN
  digits keep their order under Urdu.
- `src/app/operator/[site]/load/[id]/stage-stacks.tsx:253` forces `dir="ltr"` on a mono
  tabular-numeric span.
- Number entry (`number-stepper.tsx`) uses `tabular-nums` + `type="number"` — Western digits,
  LTR by construction.

**Number/date formatting:** `src/lib/format.ts` maps `en→en-US`, `es→es-MX`, `ur→ur-PK` via
`Intl.DateTimeFormat`. Note `ur-PK` renders **Urdu (Eastern Arabic-Indic) numerals** in
formatted dates/times, while operational counts/weights/PINs stay Western. This split is correct
and intended (see §5 RTL rules) but must be stated so it isn't "fixed" by mistake.

---

## 2. What the iPad surfaces ACTUALLY support today (evidence)

Every operator route was scanned for `useT`/`translate`/hardcoded strings.

**Fully translated, correctly (post-auth surfaces):**
`/operator` root picker, `/operator/[site]` name-picker, `/operator/[site]/[userId]` keypad,
`/today`, `/inbound`, `/count`, `/processed`, `/queue` (+ pending-banner, sign-out-button),
`/load/[id]` workflow and all eight stages (bol, weight, door, decision, stacks, reject, finish,

- photo-input). All user-visible copy routes through `useT()`/`translate()`; all `label=` props
  (incl. every `NumberStepper`) resolve to `t(...)`. Two zero-i18n files are legitimately clean:
  `number-stepper.tsx` (numeric only; label is a translated prop) and `queue-row.tsx`
  (presentational wrapper, children only).

**Hardcoded-string scan result:** ZERO hardcoded user-visible JSX text nodes, ZERO hardcoded
`placeholder`/`aria-label`/`title`/`alt` English attributes, ZERO multi-word English string
literals in operator `*.tsx`. (Brand token `alt="DR3-Vision"` is a proper noun — acceptable.)

**Message-file key parity (leaf-key set difference across locales):**

- `operator`: en=222, es=227, ur=227 real+meta. The ONLY differences are five inert
  `_meta._comment_1..5` keys present in es/ur (translator notes), absent in en. **All 222 real
  content keys are present in all three locales.**
- `manager`: en=176, es=177, ur=177 — same story, one `_meta._comment_3` diff. **All real keys
  present in all three.**
  → **Content parity is CLEAN today.** The risk is future drift, not present gaps (D-5).

### The real gaps

**D-1 — No locale switcher anywhere on the iPad/floor shell.**
`LocalePicker` (`src/app/login/locale-picker.tsx`) is mounted ONLY at `/login`
(`src/app/login/page.tsx:45`). Floor operators authenticate through the PIN flow
(`/operator` → `/operator/[site]` name-picker → `/operator/[site]/[userId]` keypad) and **never
touch `/login`**. There is no language control in the entire `/operator` route group. A manager
(Entra SSO via `/login`) CAN switch; a floor operator CANNOT. That asymmetry is the core defect.

**D-2 — Pre-auth floor screens are hard-forced to English.**
`/operator`, the name-picker, and the keypad call `getLocale()` (`src/i18n/get-locale.ts`) with
**no session yet** and (for floor staff) **no `dr3_locale` cookie**, so resolution falls all the
way to `DEFAULT_LOCALE = 'en'`. The Spanish/Urdu operator sees "Who's working?" and "Enter your
PIN" in English — the exact screens they must read to sign in. Precedence today:
`?lang=` > cookie > session `users.locale` > `'en'`.

**D-3 — `users.locale` is never populated for floor operators, so even POST-auth defaults to
English.** `users.locale` is written in only two places:

1. `setLocaleAction` (`src/i18n/actions.ts`) — invoked only by the `/login` LocalePicker (floor
   staff never reach it); and
2. `mirrorLocaleCookie` (`src/lib/auth.ts:46`) — on PIN sign-in it copies the `dr3_locale`
   cookie into `users.locale`, but floor staff have no cookie, so it no-ops.
   There is **no admin editor** for an operator's locale (`src/app/admin/users/[id]` exposes no
   `locale` field; grep of `src/app/admin` for a user-locale control returns nothing). Result: every
   floor operator's `users.locale` stays at the DB default `en` forever → post-auth surfaces
   (queue/today/inbound/count/processed/load) also render English. **The translations exist but are
   unreachable for the floor.**

**D-4 — Shared-iPad cookie precedence hazard.** The `dr3_locale` cookie is device-global and
lives one year. `getLocale()` prefers it OVER the signed-in operator's `users.locale`, and
`mirrorLocaleCookie` OVERWRITES each PIN operator's stored `users.locale` with the device cookie
value on every sign-in. So if a manager ever logs in via `/login` on a shared iPad and picks a
language, that pick (a) pins the whole shift to that language for a year and (b) corrupts each
operator's stored preference. Cookie-over-session is the wrong precedence for a shared kiosk.

**D-5 — No key-parity enforcement (silent-drift risk).** `src/i18n/dictionary.ts` claims
"if any drift, the typecheck fails at compile time," but `es: esOperator as Dictionary` and
`ur: urOperator as Dictionary` (lines 38-39, 44-45) are **type assertions that defeat the
structural check**. A builder who adds an `en` key for a new surface and forgets es/ur gets NO
error; `resolvePath` then returns the raw dot-path key (e.g. `floor.count.program_label`) to the
Spanish/Urdu operator. For money/UX-safe actions (Confirm / Correct / Save, counts, program vs
non-program) that is a silent mixed-language failure — precisely the outcome Bill's constraint
forbids.

---

## 3. GAP TABLE — LOCALE × SURFACE (the direct answer to Bill)

"Covered" = message keys present AND no hardcoded strings AND RTL correct AND the operator can
actually reach it in that language end-to-end.

| Surface (iPad/floor)               | Strings translated? | RTL (ur) correct? | Floor operator can SELECT & PERSIST es/ur? | Net for es/ur floor operator |
| ---------------------------------- | :-----------------: | :---------------: | :----------------------------------------: | ---------------------------- |
| `/operator` site picker            |         ✅          |        ✅         |                ❌ (D-1/D-2)                | Renders EN — no path in      |
| `/operator/[site]` name-picker     |         ✅          |        ✅         |                ❌ (D-1/D-2)                | Renders EN — no path in      |
| `/operator/[site]/[userId]` keypad | ✅ (digits LTR ok)  |        ✅         |                ❌ (D-1/D-2)                | Renders EN — no path in      |
| `/today` hub                       |         ✅          |        ✅         |                  ❌ (D-3)                  | Renders EN (users.locale=en) |
| `/inbound`                         |         ✅          |        ✅         |                  ❌ (D-3)                  | Renders EN                   |
| `/count`                           |         ✅          |        ✅         |                  ❌ (D-3)                  | Renders EN                   |
| `/processed`                       |         ✅          |        ✅         |                  ❌ (D-3)                  | Renders EN                   |
| `/queue` (+banner, sign-out)       |         ✅          |        ✅         |                  ❌ (D-3)                  | Renders EN                   |
| `/load/[id]` workflow + 8 stages   |         ✅          |        ✅         |                  ❌ (D-3)                  | Renders EN                   |

**Bottom line for Bill:** the iPad surfaces _ship_ the exact same language set as the main portal
(en/es/ur) and are fully translated with correct RTL — **but a Spanish- or Urdu-reading floor
operator cannot actually use them in their language today.** The sign-in screens force English
(D-2), there is no switcher on the floor shell (D-1), their stored preference is never set (D-3),
and a shared iPad can pin everyone to one language (D-4). The capability is built but unreachable.
So the honest answer to "are all iPad surfaces available in the same languages as the main
portal?" is: **the translations are; the operator's access to them is not — until D-1..D-4 land.**

There are **no missing translation keys** to add for existing surfaces (parity is clean, §2).
The work is a reachable, per-operator, shared-device-safe locale-selection + persistence path,
plus a CI guard so parity can never silently rot (D-5).

---

## 4. Build tasks

### T-1 (D-1 + D-2) — Floor locale switcher on the operator shell, usable pre-auth

- Add an operator-namespace switcher component, e.g.
  `src/app/operator/_components/floor-locale-switcher.tsx` (client), rendering the three
  `LOCALE_LABELS` as ≥44px tap targets (match ADR-0060 sizing), each written in its own script.
- On tap it calls a **new** server action `setFloorLocaleAction(locale)` (see T-3) — do NOT reuse
  the login `setLocaleAction` unchanged, because its cookie write is the source of D-4.
- Mount it where a not-yet-signed-in operator will see it: the `/operator` picker, the
  `/operator/[site]` name-picker header, and the `/operator/[site]/[userId]` keypad header. The
  simplest single mount is in `src/app/operator/layout.tsx` (already resolves `locale`), pinned
  top-corner, so it's present on every operator screen incl. post-auth (lets an operator fix the
  language mid-shift too). Keep it out of the RTL-sensitive numeric zones.
- The switcher reads current `locale` from `useLocale()` and highlights the active choice.

### T-2 (D-4) — Shared-iPad-safe locale resolution precedence

Change `getLocale()`/`resolveLocale()` precedence so the **signed-in operator's `users.locale`
wins over the device cookie**, while keeping the cookie for the pre-auth (no-session) case:

- New precedence: `?lang=` (debug) > session `users.locale` (if a session exists) > `dr3_locale`
  cookie (pre-auth only) > `'en'`.
- Rationale: on a shared kiosk the person who is signed in must see THEIR language; the cookie is
  only a pre-auth hint for the sign-in screens. This directly removes the "one manager pins the
  shift for a year" failure.
- Keep the cookie short-lived for the floor path if feasible (a shift, not a year) — but the
  precedence flip is the load-bearing fix; TTL is secondary.

### T-3 (D-3) — Persist the floor operator's choice to `users.locale` without the cookie hazard

- New server action `setFloorLocaleAction(locale)`:
  - If a session exists: write `users.locale` directly (authoritative per-operator preference) and
    set the cookie only as a short-lived pre-auth convenience (or skip it entirely).
  - If no session yet (operator still on name-picker/keypad): set a **session-scoped / short-TTL**
    `dr3_locale` cookie so the sign-in screens localize immediately; then on PIN auth,
    `mirrorLocaleCookie` (unchanged) folds it into `users.locale`. This gives: tap Español on the
    name-picker → sign-in screens flip to Spanish → after PIN, Spanish is persisted to that
    operator and follows them to any iPad.
- **Do NOT change PIN/login auth logic** beyond what already exists — `mirrorLocaleCookie` stays
  as-is; the parent owns the auth-bounce fix. If T-2's precedence flip means the cookie should be
  cleared after mirroring to avoid re-pinning, do that clear inside `setFloorLocaleAction`/the
  action layer, not in the credentials provider.
- OPTIONAL (nice-to-have, low risk): add a `locale` select to `src/app/admin/users/[id]` so a
  manager can pre-set an operator's language. Not required if T-1..T-3 land, but it removes the
  first-shift English exposure entirely.

### T-4 (D-5) — Key-parity enforcement (CI guard) + remove the false type assertion

- Remove the `as Dictionary` / `as ManagerDictionary` casts in `src/i18n/dictionary.ts` where
  practical, or add an explicit `satisfies`-based shape check, so structural drift is a real
  compile error again — but the assertion alone is insufficient (types don't cover value-level
  emptiness). Ship a **runtime/CI test** as the real guard (see §6).
- Strip inert `_meta._comment*` keys from the parity comparison (they are the only current diff).

---

## 5. RTL correctness rules (must hold across all four ADR-0060 surfaces + keypad)

- Page direction comes from root `<html dir>` (already wired) — do not re-implement per surface.
- **Numerals policy (state explicitly, do not "fix"):** operational numerics — mattress counts,
  weights, PIN digits, stepper values — stay **Western digits, LTR**, via `tabular-nums`,
  `type="number"`, and the existing `dir="ltr"` overrides in `keypad.tsx` and `stage-stacks.tsx`.
  Only `Intl`-formatted dates/times (`format.ts`, `ur-PK`) may localize numerals. Any NEW numeric
  display on a floor surface under Urdu must carry `dir="ltr"` on its span.
- The floor locale switcher itself must not sit inside an LTR-forced numeric island; place it in
  the header/chrome where RTL mirroring is correct.
- Verify by eye (no exceptions) that in `ur`, action buttons (Confirm/Correct/Save, program vs
  non-program toggles) are fully Urdu, right-aligned, and never show a raw dot-path key.

---

## 6. Test plan

1. **Key-parity unit test** (the D-5 guard, CI-blocking). New test e.g.
   `src/i18n/locale-parity.test.ts`: load every `locales/*/{operator,manager}.json`, compute the
   leaf-key set per file (ignoring `_meta.*`), assert all locales' key sets are identical to `en`
   in BOTH directions (no missing, no extra). Fails the build if any locale drifts. This is the
   mechanism that guarantees "same languages" stays true for every future surface.
2. **Resolution-precedence unit test** for `getLocale`/`resolveLocale`: session `users.locale`
   beats cookie when a session exists; cookie used only pre-auth; `?lang=` overrides; default en.
   Include the shared-iPad case (cookie=es, session user.locale=ur → expect ur).
3. **iPad-viewport visual gate (reviewed BY EYE, per the UI visual-verification standard).**
   Playwright at iPad viewport (e.g. 1024×768 landscape + 768×1024 portrait). For EACH of the
   nine floor surfaces × EACH locale {en, es, ur} render and screenshot:
   - sign-in trio (`/operator`, name-picker, keypad) actually renders in the selected locale
     BEFORE auth (proves D-2 fixed);
   - post-auth surfaces render in the signed-in operator's locale (proves D-3 fixed);
   - `ur` screenshots: RTL layout correct, numerals/keypad LTR, no untranslated dot-path keys,
     critical actions fully localized (proves money/UX-safe constraint).
     Review the matrix by eye; overflow-free + tests-green alone is NOT "done".
4. **Verify on the live URL** after deploy (public DR3 hostname, not localhost) at an iPad
   viewport in each locale.

---

## 7. Deploy / dirty-tree hazard (FLAG)

Writing these design docs (this plan + the ADR + CHANGELOG/index edits) **into the DR3-Vision
main checkout on CHAD has repeatedly jammed the deployer's dirty-tree guard** (same failure class
as the barnardhq working-tree hold). **The builder must do all of this — code AND docs — inside a
git worktree on a feature branch, never in the main checkout.** Land via PR + the normal
required-checks gate (auto-merge is OFF; poll-and-merge). After merge, verify the CONTAINER
(`docker exec dr3-vision-app`) reflects the change, not just git HEAD — the CHAD deployer can
build/migrate from a pre-pull tree (known DR3 build-races-pull race).

## 8. Out of scope

- Auth/PIN-login bounce fix (parent owns it).
- `/admin` localization (English-only by ADR-0017).
- Adding locales beyond en/es/ur (no new language requested; parity is against the existing set).
