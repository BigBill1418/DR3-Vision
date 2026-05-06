import argon2 from 'argon2';

// Argon2id parameter set. Defaults from `argon2` v0.41 are already
// argon2id, but we pin them here so a library bump doesn't silently
// change cost factors. Tuned for ~250 ms hash on a modern x86_64;
// the manager/admin login path is rare-enough traffic that this is
// fine, and the operator PIN flow has its own (separate) verification
// per ADR-0004.
const HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB — OWASP 2024 minimum
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, HASH_OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    // Malformed hash, mismatched algorithm, etc. Treat as failed verify
    // rather than 500 — the seed bootstrap sentinel
    // ('pending_first_password_reset') hits this path.
    return false;
  }
}
