-- O-2 (2026-07-16) — admin file-drop inbox.
--
-- PURELY ADDITIVE (ADR-0035 clean-replay invariant: replays on an empty PG16 in
-- CI). Adds ONE enum and ONE table; no existing table is dropped or altered, and
-- no data statement uses the new enum value in THIS transaction, so the Postgres
-- "unsafe use of a freshly-added enum value in the same transaction" rule never
-- applies.
--
-- The `file_drops` table is a raw capture inbox: an admin uploads ANY file through
-- /admin/file-drop, the bytes go to R2 (`file-drops/<id>/<sanitized-name>`), and one
-- manifest row lands here. `uploaded_by` is a bare audit-actor user id with NO FK
-- (mirrors ap_requests.held_by / decided_by, per the AP audit-column convention).
--
-- The dir name `20260724_admin_file_drops` sorts AFTER the current main chain tip
-- (`20260723_user_sessions_invalidated_at`), preserving ADR-0035 lexical ordering.

-- CreateEnum
CREATE TYPE "FileDropStatus" AS ENUM ('received', 'routed', 'discarded');

-- CreateTable
CREATE TABLE "file_drops" (
    "id" TEXT NOT NULL,
    "original_filename" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "r2_key" TEXT NOT NULL,
    "status" "FileDropStatus" NOT NULL DEFAULT 'received',
    "detected_kind" TEXT,
    "note" TEXT,
    "uploaded_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "file_drops_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "file_drops_status_created_at_idx" ON "file_drops"("status", "created_at");

-- CreateIndex
CREATE INDEX "file_drops_created_at_idx" ON "file_drops"("created_at");
