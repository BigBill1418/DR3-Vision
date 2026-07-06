// ADR-0046 D1 — delta-token persistence per mailbox+folder (survives restarts).
//
// A lost/absent token degrades to a full-folder resync; idempotency
// (internet_message_id UNIQUE) absorbs the re-list. The token is stored opaque —
// for graphTransport it is the full @odata.deltaLink URL; for mockTransport an
// increasing marker. Neither is a secret, but it is not logged (delta URLs carry
// query state). The prisma client is a parameter (defaults to the singleton) so
// the poll orchestrator can pass its injected client uniformly.

import { prisma as defaultPrisma } from '@/lib/prisma';
import type { PrismaClient } from '@prisma/client';

export async function loadDeltaToken(
  mailbox: string,
  folder: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<string | null> {
  const row = await prisma.apDeltaToken.findUnique({
    where: { mailbox_folder: { mailbox, folder } },
    select: { delta_token: true },
  });
  return row?.delta_token ?? null;
}

export async function saveDeltaToken(
  mailbox: string,
  folder: string,
  token: string,
  prisma: PrismaClient = defaultPrisma,
): Promise<void> {
  await prisma.apDeltaToken.upsert({
    where: { mailbox_folder: { mailbox, folder } },
    create: { mailbox, folder, delta_token: token },
    update: { delta_token: token },
  });
}
