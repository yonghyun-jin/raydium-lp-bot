// Pool reads from the Raydium REST API.

import { config, TOKENS } from '../config';
import { RAYDIUM_API, CLMM_PROGRAM_ID, AMM_V4_PROGRAM_ID } from './constants';

export interface PoolInfo {
  id: string;
  mintA: { symbol: string; address: string; decimals: number; programId?: string };
  mintB: { symbol: string; address: string; decimals: number; programId?: string };
  price: number;
  tvl: number;
  feeRate: number;
  tickCurrent: number;
  tickSpacing: number;
  programId: string;
}

/**
 * Fetch pool info directly from Raydium API
 */
export async function fetchPoolInfo(poolId: string): Promise<PoolInfo | null> {
  try {
    const response = await fetch(`${RAYDIUM_API}/pools/info/ids?ids=${poolId}`);
    const data = await response.json() as { success: boolean; data: any[] };

    if (!data.success || !data.data || data.data.length === 0) {
      console.error('Pool not found:', poolId);
      return null;
    }

    const pool = data.data[0];

    // Validate pool is CLMM, not AMM V4
    if (pool.programId === AMM_V4_PROGRAM_ID) {
      console.error(`❌ Pool ${poolId} is AMM V4 (Standard), not CLMM (Concentrated)`);
      console.error('   CLMM positions can only be created on CLMM pools.');
      console.error('   Use a CLMM pool like: 3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv');
      return null;
    }

    if (pool.programId !== CLMM_PROGRAM_ID) {
      console.warn(`⚠️ Pool ${poolId} has unknown program ID: ${pool.programId}`);
    }

    return {
      id: pool.id,
      mintA: pool.mintA,
      mintB: pool.mintB,
      price: pool.price,
      tvl: pool.tvl,
      feeRate: pool.feeRate,
      tickCurrent: pool.tickCurrent || 0,
      tickSpacing: pool.config?.tickSpacing || 1,
      programId: pool.programId,
    };
  } catch (e) {
    console.error('Error fetching pool info:', e);
    return null;
  }
}

/**
 * Get SOL-USDC pools from API
 */
export async function getSolUsdcPools(): Promise<any[]> {
  try {
    const mint1 = TOKENS.SOL.toString();
    const mint2 = config.network.IS_DEVNET ? TOKENS.USDC_DEV.toString() : TOKENS.USDC.toString();

    const response = await fetch(
      `${RAYDIUM_API}/pools/info/mint?mint1=${mint1}&mint2=${mint2}&poolType=concentrated&poolSortField=liquidity&sortType=desc&pageSize=10&page=1`
    );
    const data = await response.json() as { success: boolean; data: { data: any[] } };

    if (!data.success || !data.data) {
      return [];
    }

    return data.data.data || [];
  } catch (e) {
    console.error('Error getting pools:', e);
    return [];
  }
}
