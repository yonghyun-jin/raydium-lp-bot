import { randomBytes } from 'crypto';
// Config - All information needed for position creation

export interface Config {
  // Range
  priceLower: number;      // 80.96
  priceUpper: number;      // 82.60

  // Coins
  coin1: string;           // "SOL" (base coin)
  coin2: string;           // "USDC"

  // Job connection
  /** Groups one P&L cycle: the funding swap, the open and the close. */
  operationId: string;

  // Funds
  coin1Amount: number;     // 0.8 SOL
  coin2Amount: number;     // 68 USDC

  // Duration
  duration: number;        // hours, 0 = unlimited

  // Pool information
  poolId: string;          // Raydium pool ID
  /**
   * The nft mint this position replaces, when the create is the second half of
   * a rebalance. Recorded as `positions.prev_position_id`.
   *
   * Carried on the Config so it reaches `handleNewPosition`, the single funnel
   * every create passes through, rather than being threaded as a parameter
   * through each caller.
   */
  prevPositionMint?: string;
}

// Config creation helper
/**
 * A fresh operation id.
 *
 * This is the key that groups one P&L cycle -- the swap that funds a position,
 * the open, and the close all carry it -- so two cycles sharing one id merge
 * silently into a single wrong number.
 *
 * It used to be `job_<ms>`, which collides for anything created inside
 * the same millisecond. That is unlikely here, since a create is several RPC
 * round trips, but the failure is quiet: nothing errors, the ledger simply
 * reports one operation where there were two. A random suffix removes the
 * question.
 *
 * The timestamp prefix stays because it is genuinely useful -- ids sort
 * chronologically in logs and in a ledger listing -- but it is no longer what
 * makes them unique.
 */
export function newOperationId(): string {
  return `op_${Date.now()}_${randomBytes(4).toString('hex')}`;
}

export function createConfig(params: {
  priceLower: number;
  priceUpper: number;
  coin1?: string;
  coin2?: string;
  operationId?: string;
  coin1Amount: number;
  coin2Amount: number;
  duration?: number;
  poolId: string;
}): Config {
  return {
    priceLower: params.priceLower,
    priceUpper: params.priceUpper,
    coin1: params.coin1 || 'SOL',
    coin2: params.coin2 || 'USDC',
    operationId: params.operationId || newOperationId(),
    coin1Amount: params.coin1Amount,
    coin2Amount: params.coin2Amount,
    duration: params.duration ?? 0,
    poolId: params.poolId,
  };
}

// Validation
export function validateConfig(config: Config): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (config.priceLower >= config.priceUpper) {
    errors.push('priceLower must be less than priceUpper');
  }
  if (config.coin1Amount < 0) {
    errors.push('coin1Amount must be non-negative');
  }
  if (config.coin2Amount < 0) {
    errors.push('coin2Amount must be non-negative');
  }
  if (config.duration < 0) {
    errors.push('duration must be non-negative');
  }
  if (!config.poolId) {
    errors.push('poolId is required');
  }
  if (!config.operationId) {
    errors.push('operationId is required');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
