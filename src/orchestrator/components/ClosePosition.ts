// ClosePosition - Close LP position and report what it produced

import { LpClient } from '../../raydium/LpClient';
import { ClosePositionResult } from '../types';

export class ClosePosition {
  private client: LpClient;

  constructor(client: LpClient) {
    this.client = client;
  }

  /**
   * Close a position and report what came back.
   *
   * - decreaseLiquidity (100%)
   * - closePosition (NFT burn)
   *
   * READS BEFORE IT SENDS, and that ordering is the whole point. A successful
   * close burns the position account, so the fees it accrued and what it was
   * worth exist only until the moment it lands. This used to return `{ txId }`
   * alone; the Telegram bot therefore closed positions itself in order to
   * bracket the call with balance reads, which is how a money-path operation
   * came to live in the UI layer.
   *
   * Nothing here throws on a failed READ -- the close is the operation, and
   * refusing it because a balance query timed out would strand a position the
   * caller asked to exit. The nulls are reported instead, and it is the
   * CALLER's business what an absent figure means: the rebalance refuses when
   * `valueBeforeUsd` is null because that value is its budget; `/close` simply
   * reports "unknown". A failed SEND still throws, and a `SendBlockedError`
   * under DRY_RUN still escapes -- a close that reports success while money is
   * on-chain is the mirror of the phantom-position bug.
   */
  async execute(nftMint: string): Promise<ClosePositionResult> {
    console.log(`[ClosePosition] Closing position: ${nftMint}`);

    const { feesEarnedUsd, valueBeforeUsd, feeSol, feeUsdc } = await this.readBeforeClosing(nftMint);
    const before = await this.readBalances();

    const result = await this.client.closePosition(nftMint);

    const after = await this.readBalances();

    const solWithdrawn =
      before && after ? after.sol - before.sol : null;
    const usdcWithdrawn =
      before && after ? after.usdc - before.usdc : null;

    console.log(`[ClosePosition] Position closed!`);
    console.log(`  - TX: ${result.txId}`);
    console.log(
      `  - withdrawn: ${solWithdrawn === null ? 'unknown' : solWithdrawn.toFixed(6)} SOL, ` +
        `${usdcWithdrawn === null ? 'unknown' : usdcWithdrawn.toFixed(2)} USDC`
    );
    console.log(
      `  - fees: ${feesEarnedUsd === undefined ? 'unknown' : '$' + feesEarnedUsd.toFixed(4)}`
    );

    return {
      txId: result.txId,
      decreaseTxId: result.decreaseTxId,
      withdrewLiquidity: result.withdrewLiquidity,
      solWithdrawn,
      usdcWithdrawn,
      feesEarnedUsd,
      valueBeforeUsd,
      feeSol,
      feeUsdc,
    };
  }

  /**
   * The position's earnings and value, read while it still exists.
   *
   * The two absences mean different things, so they are typed differently:
   * `undefined` fees are recorded as NULL (0 would mean "earned nothing"), and
   * a null value refuses a rebalance (it is the replacement's budget).
   */
  private async readBeforeClosing(
    nftMint: string
  ): Promise<{
    feesEarnedUsd: number | undefined;
    valueBeforeUsd: number | null;
    feeSol: number | undefined;
    feeUsdc: number | undefined;
  }> {
    try {
      const details = await this.client.getPositionDetails(nftMint);
      if (!details) {
        console.warn(`[ClosePosition] ${nftMint} could not be read before closing.`);
        return {
          feesEarnedUsd: undefined,
          valueBeforeUsd: null,
          feeSol: undefined,
          feeUsdc: undefined,
        };
      }

      const feesEarnedUsd =
        details.feeA === null || details.feeB === null
          ? undefined
          : details.feeA * details.currentPrice + details.feeB;

      if (feesEarnedUsd === undefined) {
        console.warn(`[ClosePosition] Fees for ${nftMint} unreadable; recording unknown.`);
      }

      return {
        feesEarnedUsd,
        valueBeforeUsd: details.totalValueUsd,
        feeSol: details.feeA ?? undefined,
        feeUsdc: details.feeB ?? undefined,
      };
    } catch (error: any) {
      console.warn(`[ClosePosition] Pre-close read failed:`, error?.message ?? error);
      return {
        feesEarnedUsd: undefined,
        valueBeforeUsd: null,
        feeSol: undefined,
        feeUsdc: undefined,
      };
    }
  }

  /** Wallet balances, or null if they cannot be read. */
  private async readBalances(): Promise<{ sol: number; usdc: number } | null> {
    try {
      return {
        sol: await this.client.getSolBalance(),
        usdc: await this.client.getUsdcBalance(),
      };
    } catch (error: any) {
      console.warn(`[ClosePosition] Balance read failed:`, error?.message ?? error);
      return null;
    }
  }
}
