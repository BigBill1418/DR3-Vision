// ADR-0004 PIN policy at create/change time. Lookup attacks are
// bounded by rate-limiting (`src/lib/pin-service.ts`); this validator
// keeps users from picking the patterns that effectively shrink the
// 10,000-PIN keyspace by orders of magnitude.

const FOUR_DIGITS = /^\d{4}$/;

function isFourDigits(pin: string): boolean {
  return FOUR_DIGITS.test(pin);
}

function isAllSame(pin: string): boolean {
  return pin[0] !== undefined && pin.split('').every((d) => d === pin[0]);
}

function isSequential(pin: string): boolean {
  // 1234, 4321, 0123, 9876, ...
  const digits = pin.split('').map((c) => Number.parseInt(c, 10));
  const ascending = digits.every((d, i) => i === 0 || d === (digits[i - 1] ?? -99) + 1);
  const descending = digits.every((d, i) => i === 0 || d === (digits[i - 1] ?? -99) - 1);
  return ascending || descending;
}

function isRepeatedPair(pin: string): boolean {
  // 1212, 3434, 0707, ...
  return pin[0] === pin[2] && pin[1] === pin[3] && pin[0] !== pin[1];
}

export type PinValidationError = 'not_four_digits' | 'all_same' | 'sequential' | 'repeated_pair';

export function validatePinPattern(pin: string): PinValidationError | null {
  if (!isFourDigits(pin)) return 'not_four_digits';
  if (isAllSame(pin)) return 'all_same';
  if (isSequential(pin)) return 'sequential';
  if (isRepeatedPair(pin)) return 'repeated_pair';
  return null;
}
