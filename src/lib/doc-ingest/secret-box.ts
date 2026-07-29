// ADR-0067 Amendment A §A.7 — AES-256-GCM at rest for the delegated tokens.
//
// Same pattern as the MyMRC credential store (ADR-0057 D1/D9): a DEDICATED
// secret, scrypt to an AES-256 key with a fixed app-specific salt, GCM with a
// random 12-byte nonce, and a persisted `key_version` that gates decrypt so a
// scheme rotation can never silently produce garbage plaintext.
//
// ── Why a dedicated key, again ──────────────────────────────────────────────
// `MYMRC_CRED_KEY` protects Salesforce-portal creds; this protects a Graph
// refresh token that can read every document shared with the service account.
// One key for both would make a MyMRC-scrape compromise a document-store
// compromise. Separate keys keep the blast radii separate — the same reasoning
// ADR-0057 used to refuse deriving from NEXTAUTH_SECRET.
//
// ── Fail-soft MOUNT, fail-LOUD code (§A.7) ──────────────────────────────────
// `~/.dr3-vision-secrets/doc-ingest.env` is mounted OPTIONAL, so the app boots
// on a host that has not been provisioned yet. That is the only softness. Once
// code actually needs the key, a missing key THROWS
// `DocIngestKeyUnavailableError`. It never degrades to "not connected", never
// returns null, and never no-ops — a silent no-op on a credential path is the
// exact failure class ADR-0057 D9 exists to eliminate.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * ── NO NEW SECRET, BY DESIGN ────────────────────────────────────────────────
 *
 * An earlier revision required a dedicated `DOC_INGEST_TOKEN_KEY` in a new
 * `doc-ingest.env`. That was wrong twice over: it contradicts the operator rule
 * against `.env` files for credential material, and it made the whole feature
 * wait on a manual provisioning step for no cryptographic benefit.
 *
 * The key is now DERIVED from `MYMRC_CRED_KEY` — the dedicated 32-byte
 * credential-encryption secret ADR-0057 already established and which is
 * already mounted on the app container. Domain separation comes from the
 * scrypt salt below, so the two subsystems never share an AES key: recovering
 * the doc-ingest key does not yield the MyMRC one, and vice versa.
 *
 * ROTATION CONSEQUENCE, stated plainly: rotating `MYMRC_CRED_KEY` makes stored
 * doc-ingest tokens undecryptable. That is CHEAP here and expensive nowhere —
 * a refresh token is re-obtainable by clicking Connect once. `open()` already
 * fails closed on a wrong key, and `access-token.ts` latches
 * `reauth_required` + pages, so the failure is loud and the remedy is a
 * single re-auth rather than data loss. The MyMRC credentials, by contrast,
 * would need re-entering — so the coupling costs strictly less than the
 * separate-secret alternative it replaces.
 */
const KEY_ENV = 'MYMRC_CRED_KEY';

/**
 * Fixed, app-specific, NON-secret scrypt salt. Pins the KDF so the same
 * root secret always derives the same AES key, AND provides the domain
 * separation that keeps this key independent of MyMRC's. Rotating the
 * encryption SCHEME means bumping this salt and `CURRENT_KEY_VERSION` together.
 */
const KEY_SALT = 'dr3-vision.doc-ingest.tokenstore.v1';

/** Encryption scheme version persisted per row; gates decrypt. */
export const CURRENT_KEY_VERSION = 1;

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard nonce length
const KEY_BYTES = 32; // AES-256

/** The root credential key is missing/empty — cannot encrypt or decrypt. LOUD. */
export class DocIngestKeyUnavailableError extends Error {
  override readonly name = 'DocIngestKeyUnavailableError';
  constructor(message: string) {
    super(message);
  }
}

/**
 * Decryption failed CLOSED: the GCM auth check rejected the ciphertext/iv/tag
 * (tampering or wrong key), or the stored `key_version` is not decryptable by
 * the current scheme. Never surfaces partial plaintext and never degrades to
 * "not configured".
 */
export class DocIngestDecryptError extends Error {
  override readonly name = 'DocIngestDecryptError';
  constructor(message: string) {
    super(message);
  }
}

/** A sealed value: base64 ciphertext + base64 nonce + base64 GCM tag. */
export interface SealedValue {
  ciphertext: string;
  iv: string;
  authTag: string;
}

function deriveKey(): Buffer {
  const secret = process.env[KEY_ENV]?.trim();
  if (!secret) {
    throw new DocIngestKeyUnavailableError(
      `${KEY_ENV} is not set — cannot encrypt or decrypt document-ingestion tokens. ` +
        'It is the ADR-0057 credential key and is mounted from ' +
        '~/.dr3-vision-secrets/mymrc-cred-key.env; document ingestion derives its own ' +
        'key from it rather than requiring a second secret.',
    );
  }
  return scryptSync(secret, KEY_SALT, KEY_BYTES);
}

/** True when the encryption key is present. For status reporting ONLY — never a gate that skips work. */
export function isKeyConfigured(): boolean {
  return Boolean(process.env[KEY_ENV]?.trim());
}

/** Encrypt a token. Throws `DocIngestKeyUnavailableError` when unkeyed. */
export function seal(plaintext: string): SealedValue {
  const key = deriveKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

/**
 * Decrypt a token. Throws `DocIngestDecryptError` on tamper/wrong key or an
 * undecryptable `keyVersion`, and `DocIngestKeyUnavailableError` when unkeyed.
 */
export function open(sealed: SealedValue, keyVersion: number = CURRENT_KEY_VERSION): string {
  if (keyVersion !== CURRENT_KEY_VERSION) {
    throw new DocIngestDecryptError(
      `document-ingestion token key_version ${keyVersion} is not decryptable by scheme ${CURRENT_KEY_VERSION}`,
    );
  }
  const key = deriveKey();
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(sealed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(sealed.authTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new DocIngestDecryptError(
      'document-ingestion token decryption failed the integrity check',
    );
  }
}

/**
 * Seal an arbitrary JSON-serializable payload into ONE opaque base64 string.
 * Used for the short-lived OAuth handshake cookie (state + PKCE verifier),
 * which needs the same confidentiality + integrity but has no DB row to carry
 * three separate columns.
 */
export function sealToString(payload: unknown): string {
  const s = seal(JSON.stringify(payload));
  return Buffer.from(`${s.iv}.${s.authTag}.${s.ciphertext}`, 'utf8').toString('base64url');
}

/**
 * Inverse of {@link sealToString}. Throws `DocIngestDecryptError` on any
 * malformed or tampered input — a forged handshake cookie is rejected, never
 * best-effort parsed.
 */
export function openFromString(token: string): unknown {
  let parts: string[];
  try {
    parts = Buffer.from(token, 'base64url').toString('utf8').split('.');
  } catch {
    throw new DocIngestDecryptError('sealed payload is not valid base64url');
  }
  const [iv, authTag, ciphertext] = parts;
  if (parts.length !== 3 || !iv || !authTag || !ciphertext) {
    throw new DocIngestDecryptError('sealed payload is malformed');
  }
  try {
    return JSON.parse(open({ iv, authTag, ciphertext })) as unknown;
  } catch (e) {
    if (e instanceof DocIngestDecryptError || e instanceof DocIngestKeyUnavailableError) throw e;
    throw new DocIngestDecryptError('sealed payload did not contain valid JSON');
  }
}
