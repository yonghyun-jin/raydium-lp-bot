/**
 * LpClient — the narrow surface the money path actually uses.
 *
 * Orchestrator and its components depend on this interface rather than on the
 * concrete RaydiumClient (1,680 lines whose constructor loads a wallet and
 * opens an RPC connection). That makes the whole create/swap/close flow
 * testable without a key, without the network, and without spending anything.
 *
 * RaydiumClient implements this, so the compiler keeps the two in step.
 */

export interface PositionDetails {
  nftMint: string;
  poolId: string;
  liquidity: string;
  tickLower: number;
  tickUpper: number;
  priceLower: number;
  priceUpper: number;
  currentPrice: number;
  amountA: number; // SOL
  amountB: number; // USDC
  /**
   * Pending fees, or null when they could not be read.
   *
   * Null is a real answer and must not be coerced to 0: the figure needs the
   * pool and both boundary tick accounts, and reporting "$0.00" for a failed
   * read is indistinguishable from a position that has truly earned nothing.
   */
  feeA: number | null; // Pending SOL fees
  feeB: number | null; // Pending USDC fees
  totalValueUsd: number;
  inRange: boolean;
}

export interface CreatePositionOutcome {
  nftMint: string;
  txId: string;
  /** SOL actually deposited, after sizing. */
  solDeposited: number;
  /** USDC actually deposited, after sizing. */
  usdcDeposited: number;
}

/** Summary of an open position, as returned by getMyPositions(). */
export interface PositionSummary {
  nftMint: string;
  poolId: string;
  liquidity: string;
  tickLower: number;
  tickUpper: number;
  priceLower: number;
  priceUpper: number;
}

/**
 * What Jupiter said it would do, preserved verbatim.
 *
 * Every field here is a QUOTE-TIME statement, not a measurement. That
 * distinction is the whole reason this type exists separately from what the
 * transaction actually did: `priceImpactPct` is the router's estimate BEFORE
 * the swap, and it is NOT the execution slippage, which is `outAmount` (quoted)
 * against what the wallet really received. Writing the first where the second
 * belongs makes the ledger assert a number nobody measured.
 *
 * Kept as the raw shape so a later question about the route -- was a hop
 * expensive, did the platform take a cut -- needs no new plumbing.
 */
export interface SwapQuote {
  /** Base units of the input mint. */
  inAmount: string;
  /** Base units of the output mint, as QUOTED. The slippage baseline. */
  outAmount: string;
  /** Router's pre-trade estimate, as a percent string. Metadata, never a row. */
  priceImpactPct?: string;
  /** One entry per hop; each may charge its own fee. Multi-hop routes are normal. */
  routePlan?: Array<Record<string, unknown>>;
  /** Jupiter's own charge, separate from the per-hop DEX fees. */
  platformFee?: Record<string, unknown> | null;
  /** Anything else the router returned, so nothing is lost by this type. */
  [key: string]: unknown;
}

/**
 * What a swap is checked against before it is sent.
 *
 * REQUIRED, because the check fails closed: a swap with no reference price is
 * refused rather than accepted at whatever the router offers. Making it
 * optional would let a caller opt out of the price guard by forgetting it,
 * which is how it would be lost.
 */
export interface SwapPriceGuard {
  /** Fair price in USDC per SOL, from somewhere that is not the router. */
  referencePrice: number | null;
  /** The pool's own fee as a rate, read from the pool this trade prices against. */
  poolFeeRate: number;
}

export interface SwapResult {
  txId: string;
  /**
   * Absent when the quote could not be preserved. Callers must treat that as
   * "unknown", never as "no fees and no slippage".
   */
  quote?: SwapQuote;
}

/**
 * What one transaction actually did to THIS wallet.
 *
 * Read from `getTransaction`'s meta rather than by bracketing the send with
 * balance reads. The difference matters: a balance bracket measures the wallet
 * at two moments and attributes everything in between to this transaction,
 * so anything else touching the wallet lands in our numbers. This measures the
 * transaction itself.
 *
 * Rent is reported as two numbers, not one, because it is REFUNDABLE: the
 * lamports come back when the account closes, so over a lifecycle it nets to
 * zero and a single `rent` cost would overstate every completed cycle.
 *
 * Neither figure is a leftover. Both are attributed to the instructions that
 * actually did it -- see `readRent`. A residual would silently absorb any cost
 * nobody has modelled, which is the failure this whole scope exists to
 * prevent. See docs/v1/scopes/C3-execution-costs.md.
 */
export interface TransactionEffects {
  /** `meta.fee`, in SOL. Includes the priority fee, which this project sets. */
  networkFeeSol: number;
  /** This wallet's SOL change across the transaction. The network fee is inside it. */
  solDelta: number;
  /** Per-mint UI-amount change for token accounts this wallet owns. */
  tokenDeltas: Record<string, number>;
  /** SOL this wallet put into accounts created by this transaction. */
  rentDeposited: number;
  /** SOL returned to this wallet by accounts this transaction closed. */
  rentReclaimed: number;
}

export interface LpClient {
  init(): Promise<void>;

  getSolBalance(): Promise<number>;
  getUsdcBalance(): Promise<number>;
  getCurrentPrice(poolId?: string): Promise<number>;

  /**
   * The pool's own fee, as a rate. Null when it cannot be read.
   *
   * Part of the price band a swap is checked against, and the reason that band
   * is not a constant: this is a property of the pool, not a preference.
   */
  getPoolFeeRate(poolId: string): Promise<number | null>;

  /**
   * valueUsd bounds the swap by MAX_POSITION_USD; omit it and it is unbounded.
   * priceGuard bounds what the swap may PAY -- a separate question, and the
   * one nothing on this path used to ask.
   */
  swapSolToUsdc(solAmount: number, valueUsd?: number, priceGuard?: SwapPriceGuard): Promise<SwapResult>;
  swapUsdcToSol(usdcAmount: number, valueUsd?: number, priceGuard?: SwapPriceGuard): Promise<SwapResult>;

  /**
   * What a landed transaction did to this wallet, or null if it cannot be read.
   *
   * Null is a real answer: the rows that depend on it are then not written,
   * which is the honest outcome. Fabricating a zero fee would assert the
   * network charged nothing.
   */
  getTransactionEffects(txId: string): Promise<TransactionEffects | null>;

  createPosition(
    poolId: string,
    solAmount: number,
    usdcAmount: number,
    priceLower: number,
    priceUpper: number,
    maxRetries?: number
  ): Promise<CreatePositionOutcome>;

  /**
   * Close a position.
   *
   * Returns BOTH signatures because a close is two transactions: the burn
   * (`txId`) and the decreaseLiquidity that actually moved the tokens
   * (`decreaseTxId`, absent when its signature was lost but the withdrawal was
   * verified on-chain). Reconciling the withdrawal against the burn alone is a
   * real bug this repo shipped -- see closePosition in ./client.
   */
  closePosition(
    nftMint: string,
    maxRetries?: number
  ): Promise<{ txId: string; decreaseTxId?: string; withdrewLiquidity: boolean }>;

  getPositionDetails(nftMint: string): Promise<PositionDetails | null>;

  /** Every open CLMM position held by the wallet. */
  getMyPositions(): Promise<PositionSummary[]>;
}
