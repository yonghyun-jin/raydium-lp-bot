// Position reads that do not price fees. getPositionDetails stays in
// client.ts, where its source-level guard tests read it.

import { PublicKey } from '@solana/web3.js';
import { Raydium } from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import { CLMM_PROGRAM_ID } from './constants';
import { PoolInfo } from './pools';
import { tickToPrice } from './ticks';

/**
 * The position's CURRENT liquidity, read from chain. Null if it no longer exists.
 *
 * Ground truth for "did the withdrawal actually land": a missed signature
 * status is no evidence of failure, and a txId is no evidence of success, but
 * the position account cannot lie about what is still inside it.
 *
 * Throws on RPC failure rather than reporting a liquidity. Callers use this to
 * decide whether it is safe to destroy the account, so "I could not check"
 * must never read as "there is nothing left".
 */
export async function readPositionLiquidity(raydium: Raydium, nftMint: string): Promise<BN | null> {
  const positions = await raydium.clmm.getOwnerPositionInfo({
    programId: new PublicKey(CLMM_PROGRAM_ID),
  });
  const position = positions.find((p: any) => p.nftMint.toString() === nftMint);
  return position ? position.liquidity : null;
}

/**
 * Get all CLMM positions owned by wallet
 */
export async function getMyPositions(
  raydium: Raydium,
  fetchPoolInfo: (poolId: string) => Promise<PoolInfo | null>
): Promise<any[]> {
  try {
    const positions = await raydium.clmm.getOwnerPositionInfo({
      programId: new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'),
    });

    // Get pool info to calculate prices from ticks
    const positionsWithPrices = await Promise.all(
      positions.map(async (pos: any) => {
        const poolId = pos.poolId?.toString() || '';
        let priceLower = 0;
        let priceUpper = 0;

        if (poolId && pos.tickLower !== undefined && pos.tickUpper !== undefined) {
          try {
            const poolInfo = await fetchPoolInfo(poolId);
            if (poolInfo) {
              // SOL-USDC: mintA=SOL(9), mintB=USDC(6)
              priceLower = tickToPrice(pos.tickLower, poolInfo.mintA.decimals, poolInfo.mintB.decimals);
              priceUpper = tickToPrice(pos.tickUpper, poolInfo.mintA.decimals, poolInfo.mintB.decimals);
            }
          } catch (e) {
            console.error('Error calculating prices for position:', e);
          }
        }

        return {
          nftMint: pos.nftMint?.toString() || '',
          poolId,
          liquidity: pos.liquidity?.toString() || '0',
          tickLower: pos.tickLower || 0,
          tickUpper: pos.tickUpper || 0,
          priceLower,
          priceUpper,
        };
      })
    );

    return positionsWithPrices;
  } catch (e) {
    console.error('Error getting positions:', e);
    return [];
  }
}
