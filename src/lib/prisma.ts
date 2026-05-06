import { PrismaClient } from '@prisma/client';

// Singleton Prisma client. Next.js dev mode hot-reloads modules, which would
// otherwise create one client per HMR cycle and exhaust DB connections;
// stash the instance on globalThis to survive reloads.
//
// Production: a single PrismaClient lives for the lifetime of the standalone
// server and shares its connection pool across all request handlers.

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.prisma ?? new PrismaClient();

if (process.env['NODE_ENV'] !== 'production') {
  globalForPrisma.prisma = prisma;
}
