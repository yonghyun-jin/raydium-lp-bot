/**
 * Safety decisions for the position-close path.
 *
 * These live outside client.ts because `closePosition` is ~480 lines with three
 * separate send branches, and the two questions that actually decide whether
 * money is lost are one-liners buried inside it. They are the whole reason the
 * close path can be trusted, so they are written where they can be read and
 * tested on their own.
 *
 * Both follow the same rule: a transaction signature proves SUBMISSION, not
 * success, and the absence of a confirmation proves nothing either -- a send
 * that missed its window may still land. Neither guess is safe, so the position
 * account on chain is the only thing either function trusts.
 */

import BN from 'bn.js';

/**
 * Can an unconfirmed withdrawal be treated as complete?
 *
 * `allConfirmed` is what we observed; `liquidityAfter` is what the chain says,
 * read AFTER the wait window (null = the position no longer exists).
 *
 * The bug this replaces took the first transaction id and called it a result,
 * which then satisfied the caller's check and fell through to burning the NFT.
 */
export function withdrawalLanded(allConfirmed: boolean, liquidityAfter: BN | null): boolean {
  if (allConfirmed) return true;
  // Not confirmed in the window, but the account is empty -- it landed late.
  return liquidityAfter !== null && liquidityAfter.isZero();
}

/**
 * Refuse to burn a position NFT unless the chain says it is empty.
 *
 * Throws rather than returning a boolean: this is the last point at which a
 * mistake is recoverable, and a caller that ignores a return value would burn
 * the position anyway. "I could not check" must never read as "nothing left".
 */
export function assertSafeToBurn(nftMint: string, liquidity: BN | null): void {
  if (liquidity === null) {
    throw new Error(
      `Refusing to burn position ${nftMint}: it is not on-chain, so its state cannot be verified.`
    );
  }
  if (!liquidity.isZero()) {
    throw new Error(
      `Refusing to burn position ${nftMint}: it still holds liquidity ${liquidity.toString()}. ` +
        'The withdrawal did not land.'
    );
  }
}
