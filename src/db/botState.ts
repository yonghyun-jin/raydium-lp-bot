/**
 * Bot State Service (Prisma)
 *
 * Persist Telegram bot state to database.
 * Uses upsert pattern - one row per Telegram user.
 */

import { prisma } from './index';
import type { BotState } from '@prisma/client';

export type UserStage =
  | 'IDLE'
  | 'AWAITING_AMOUNT'
  | 'AWAITING_CONFIRMATION'
  | 'CREATING_POSITION'
  | 'MONITORING'
  | 'AWAITING_APPROVAL'
  | 'PAUSED';

/**
 * Ids are `number` here even though the columns are BIGINT: Telegram ids are
 * below 2^53 so a JS number holds them exactly, and making every caller deal
 * in `bigint` would leak a storage detail. Conversion happens at the Prisma
 * boundary in this file and nowhere else.
 */
export interface BotStateInput {
  telegramUserId: number;
  telegramChatId: number;
  stage?: UserStage;
  isMonitoring?: boolean;
  investmentAmount?: number;
  solAmount?: number;
  usdcAmount?: number;
  positionNftMint?: string;
  rebalancesToday?: number;
  lastRebalanceDate?: string;
  startedAt?: Date;
  lastNotification?: Date;
  /** IDLE | DEPLOYED. Desired state, NOT the same question as isMonitoring. */
  deployIntent?: 'IDLE' | 'DEPLOYED';
  /** Null CLEARS it -- undefined leaves it alone. See the upsert below. */
  strandedUsd?: number | null;
  strandedSince?: Date | null;
  recoveryAttempts?: number;
  lastRecoveryAt?: Date | null;
  lastTipLamports?: number | null;
}

/**
 * Get bot state for a user
 */
export async function getBotState(telegramUserId: number): Promise<BotState | null> {
  return prisma.botState.findUnique({
    where: { telegramUserId: BigInt(telegramUserId) },
  });
}

/**
 * Create or update bot state
 */
export async function upsertBotState(input: BotStateInput): Promise<BotState> {
  return prisma.botState.upsert({
    where: { telegramUserId: BigInt(input.telegramUserId) },
    create: {
      telegramUserId: BigInt(input.telegramUserId),
      telegramChatId: BigInt(input.telegramChatId),
      stage: input.stage ?? 'IDLE',
      isMonitoring: input.isMonitoring ?? false,
      investmentAmount: input.investmentAmount,
      solAmount: input.solAmount,
      usdcAmount: input.usdcAmount,
      positionNftMint: input.positionNftMint,
      rebalancesToday: input.rebalancesToday ?? 0,
      lastRebalanceDate: input.lastRebalanceDate,
      startedAt: input.startedAt,
      lastNotification: input.lastNotification,
      deployIntent: input.deployIntent ?? 'IDLE',
      strandedUsd: input.strandedUsd ?? null,
      strandedSince: input.strandedSince ?? null,
      recoveryAttempts: input.recoveryAttempts ?? 0,
      lastRecoveryAt: input.lastRecoveryAt ?? null,
      lastTipLamports: input.lastTipLamports ?? null,
    },
    update: {
      telegramChatId: BigInt(input.telegramChatId),
      ...(input.stage !== undefined && { stage: input.stage }),
      ...(input.isMonitoring !== undefined && { isMonitoring: input.isMonitoring }),
      ...(input.investmentAmount !== undefined && { investmentAmount: input.investmentAmount }),
      ...(input.solAmount !== undefined && { solAmount: input.solAmount }),
      ...(input.usdcAmount !== undefined && { usdcAmount: input.usdcAmount }),
      ...(input.positionNftMint !== undefined && { positionNftMint: input.positionNftMint }),
      ...(input.rebalancesToday !== undefined && { rebalancesToday: input.rebalancesToday }),
      ...(input.lastRebalanceDate !== undefined && { lastRebalanceDate: input.lastRebalanceDate }),
      ...(input.startedAt !== undefined && { startedAt: input.startedAt }),
      ...(input.lastNotification !== undefined && { lastNotification: input.lastNotification }),
      // `undefined` leaves a field alone; `null` CLEARS it. Clearing has to be
      // expressible, because that is how a stranded budget gets resolved once the
      // funds are back in a position -- and a cleared budget that silently
      // persisted would make the reconciler redeploy money it had already
      // deployed.
      ...(input.deployIntent !== undefined && { deployIntent: input.deployIntent }),
      ...(input.strandedUsd !== undefined && { strandedUsd: input.strandedUsd }),
      ...(input.strandedSince !== undefined && { strandedSince: input.strandedSince }),
      ...(input.recoveryAttempts !== undefined && { recoveryAttempts: input.recoveryAttempts }),
      ...(input.lastRecoveryAt !== undefined && { lastRecoveryAt: input.lastRecoveryAt }),
      ...(input.lastTipLamports !== undefined && { lastTipLamports: input.lastTipLamports }),
    },
  });
}

/*
 * REMOVED: incrementRebalanceCount and hasExceededFailureLimit.
 *
 * They were superseded by src/recording/ before they were ever wired, and
 * `hasExceededFailureLimit` FAILED OPEN: `if (!state) return false` collapsed
 * "never rebalanced" and "no row / unreachable" into "allow", i.e. a spend
 * limit that opens itself when the database is down. The live gate is
 * `hasExceededRebalanceLimit` in src/recording/, which returns null for
 * unknown and treats it as the limit being reached.
 *
 * Deleted rather than left unused: an importable fail-open spend gate is an
 * invitation, and this table once had three mutually-blind counters.
 */
