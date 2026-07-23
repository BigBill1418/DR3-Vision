// ADR-0037 — effective program/non-program source classification (Rick/Morena rules).

import { describe, it, expect } from 'vitest';
import {
  isSourceNonProgram,
  recyclerStateForJurisdiction,
  type RecyclerState,
} from './source-classification';

describe('recyclerStateForJurisdiction', () => {
  it('maps california → CA (Woodland) and oregon → OR (Eugene)', () => {
    expect(recyclerStateForJurisdiction('california')).toBe('CA');
    expect(recyclerStateForJurisdiction('oregon')).toBe('OR');
  });
});

describe('isSourceNonProgram — the definitive two-rule determination', () => {
  const CA: RecyclerState = 'CA'; // Woodland
  const OR: RecyclerState = 'OR'; // Eugene

  // ── Rule 1: explicit list (is_non_program flag) ────────────────────────────
  // The 10 CA (Woodland) charging sites — all in-state CA, so ONLY the flag makes
  // them non-program (the out-of-state rule cannot catch an in-CA site).
  const CA_CHARGING = [
    'Golden Bear', 'Monte Diablo', 'San Martin', 'Martinez', 'Petaluma',
    'Sonoma', 'Annapolis', 'Healdsburg', 'Vasco', 'Brentwood',
  ];
  it.each(CA_CHARGING)('CA charging site %s (flag=true, state=CA) → non-program', (name) => {
    expect(isSourceNonProgram({ is_non_program: true, state: 'CA' }, CA)).toBe(true);
    // name is documentation of which real site this row stands for
    expect(name).toBeTruthy();
  });

  it('OR explicit non-program (Roseburg / Recyclops: flag=true, state=OR) → non-program', () => {
    expect(isSourceNonProgram({ is_non_program: true, state: 'OR' }, OR)).toBe(true);
  });

  // ── Default: program when neither rule applies ─────────────────────────────
  it('in-state source NOT on the list (flag=false, state=CA) → program at CA', () => {
    expect(isSourceNonProgram({ is_non_program: false, state: 'CA' }, CA)).toBe(false);
  });
  it('in-state source NOT on the list (flag=false, state=OR) → program at OR', () => {
    expect(isSourceNonProgram({ is_non_program: false, state: 'OR' }, OR)).toBe(false);
  });

  // ── Rule 2: out-of-state (state ≠ recycler state) ──────────────────────────
  it('OR-generated units delivered to Woodland (state=OR, recycler=CA) → non-program', () => {
    expect(isSourceNonProgram({ is_non_program: false, state: 'OR' }, CA)).toBe(true);
  });
  it('CA-generated units delivered to Eugene (state=CA, recycler=OR) → non-program', () => {
    expect(isSourceNonProgram({ is_non_program: false, state: 'CA' }, OR)).toBe(true);
  });
  it('a distant state (state=NV, recycler=CA) → non-program', () => {
    expect(isSourceNonProgram({ is_non_program: false, state: 'NV' }, CA)).toBe(true);
  });

  // ── NULL/blank state falls back to the flag ONLY (never guesses out-of-state) ─
  it('NULL state, flag=false → program (unknown ≠ out-of-state)', () => {
    expect(isSourceNonProgram({ is_non_program: false, state: null }, CA)).toBe(false);
  });
  it('blank/whitespace state, flag=false → program', () => {
    expect(isSourceNonProgram({ is_non_program: false, state: '   ' }, OR)).toBe(false);
  });
  it('NULL state, flag=true → still non-program (explicit flag wins)', () => {
    expect(isSourceNonProgram({ is_non_program: true, state: null }, CA)).toBe(true);
  });

  // ── Comparison is case/whitespace-insensitive ──────────────────────────────
  it('state " ca " matches recycler CA (in-state, program)', () => {
    expect(isSourceNonProgram({ is_non_program: false, state: ' ca ' }, CA)).toBe(false);
  });
  it('state "or" at CA recycler is still out-of-state (non-program)', () => {
    expect(isSourceNonProgram({ is_non_program: false, state: 'or' }, CA)).toBe(true);
  });
});
