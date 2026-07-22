-- ADR-0057 D1/D9 — MyMRC admin credential store (encrypted single row).
--
-- Replaces the retired per-site env-var credential scheme. Bill enters his
-- MyMRC admin login through the admin surface; it lands here encrypted and the
-- scrape reads it from this table (never from a `.env`). The password is
-- AES-256-GCM encrypted by src/lib/mymrc/credential-store.ts — this table only
-- ever holds ciphertext + the GCM nonce/tag; the plaintext never touches
-- Postgres, a log, or an API response. `username` is a plaintext login id.
--
-- Singleton by construction: `id` defaults to 'singleton' and a CHECK pins it,
-- so at most one row can ever exist regardless of how a write is issued. Every
-- write in the module upserts on that fixed id. PURELY ADDITIVE (ADR-0035
-- clean-replay): a brand-new table, no data touched.
CREATE TABLE "mymrc_admin_credentials" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "username" TEXT NOT NULL,
    "password_ciphertext" TEXT NOT NULL,
    "password_iv" TEXT NOT NULL,
    "password_auth_tag" TEXT NOT NULL,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "mymrc_admin_credentials_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "mymrc_admin_credentials_singleton" CHECK ("id" = 'singleton')
);
