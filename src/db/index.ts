/**
 * Database Client
 *
 * Singleton Prisma client for database access.
 * Uses PostgreSQL on Railway, can fall back to SQLite for local dev.
 */

import { PrismaClient } from '@prisma/client';

// Singleton pattern for Prisma client
// Prevents multiple instances in development with hot reload
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

/**
 * Disconnect from database (for graceful shutdown)
 */
export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}

// Re-export Prisma types
export { PrismaClient };
export type { LedgerEntry, BotState, Position, Prediction } from '@prisma/client';

// Re-export services
export * as ledgerService from './ledger';
export * as botStateService from './botState';
export * as positionService from './position';
export * as predictionService from './prediction';
