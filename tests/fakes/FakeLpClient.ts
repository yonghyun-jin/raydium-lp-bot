/**
 * FakeLpClient — a simulator, not a stub.
 *
 * It reproduces the constraint that actually rejected 19 mainnet transactions:
 * the CLMM program compares the USDC a position needs against `otherAmountMax`
 * and throws `6017 PriceSlippageCheck` when the need is larger.
 *
 * `legacySizing: true` reproduces the pre-fix client behaviour (liquidity from
 * the full SOL balance, otherAmountMax from the wallet). That is what makes the
 * regression tests meaningful: with legacy sizing the fake throws 6017, with
 * the current sizing it does not.
 */

import {
  LpClient,
  PositionDetails,
  CreatePositionOutcome,
  PositionSummary,
  SwapResult,
  TransactionEffects,
} from '../../src/raydium/LpClient';
import { sizeDeposit } from '../../src/raydium/position-sizing';
import {
  alignTicks,
  liquidityFromSol,
  usdcForLiquidity,
  tickToPrice,
} from '../../src/raydium/clmmMath';

export interface FakeCall {
  method: string;
  args: unknown[];
}

export interface FakeLpClientOptions {
  sol?: number;
  usdc?: number;
  price?: number;
  tickSpacing?: number;
  decimalsA?: number;
  decimalsB?: number;
  slippage?: number;
  /** Reproduce the pre-fix sizing that failed on-chain 19 times. */
  legacySizing?: boolean;
  /**
   * Basis points the swap keeps back, split evenly between a DEX fee and
   * execution slippage. Default 0, so a frictionless swap stays frictionless
   * and every test written before execution costs existed keeps its numbers.
   * Set it to give the cost rows something real to be built from.
   */
  swapFrictionBps?: number;
  /** Defaults to the working pool's 0.04%. Null exercises the fail-closed path. */
  poolFeeRate?: number | null;
  /** SOL charged per transaction, like a network fee. Default 0. */
  networkFeeSol?: number;
  /**
   * SOL a swap locks up creating an account (a wSOL account, an ATA). Default
   * 0. The fake reclaims it in the same transaction, matching wrapAndUnwrapSol,
   * so it nets to zero unless a test wants otherwise.
   */
  swapRentSol?: number;
}

export class FakeLpClient implements LpClient {
  calls: FakeCall[] = [];

  sol: number;
  usdc: number;
  price: number;
  tickSpacing: number;
  decimalsA: number;
  decimalsB: number;
  slippage: number;
  legacySizing: boolean;
  swapFrictionBps: number;
  networkFeeSol: number;
  swapRentSol: number;
  poolFeeRate: number | null;

  /**
   * What each transaction did, keyed by signature.
   *
   * The real client reads this back from `getTransaction`; the fake records it
   * as the transaction happens, which is the same fact from the other side.
   */
  private effects = new Map<string, TransactionEffects>();

  /** Positions this fake has opened, keyed by NFT mint. */
  positions = new Map<string, PositionDetails>();
  private nextId = 1;

  constructor(opts: FakeLpClientOptions = {}) {
    this.sol = opts.sol ?? 5.05;
    this.usdc = opts.usdc ?? 498.664926;
    this.price = opts.price ?? 99.74;
    this.tickSpacing = opts.tickSpacing ?? 1;
    this.decimalsA = opts.decimalsA ?? 9;
    this.decimalsB = opts.decimalsB ?? 6;
    this.slippage = opts.slippage ?? 0.001;
    this.legacySizing = opts.legacySizing ?? false;
    this.swapFrictionBps = opts.swapFrictionBps ?? 0;
    this.networkFeeSol = opts.networkFeeSol ?? 0;
    this.swapRentSol = opts.swapRentSol ?? 0;
    this.poolFeeRate = opts.poolFeeRate ?? 0.0004;
  }

  /** Mints, so recorded deltas are keyed the way the chain keys them. */
  static readonly SOL_MINT = 'So11111111111111111111111111111111111111112';
  static readonly USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  private rec(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  /** Arguments of every call to `method`, in order. */
  argsOf(method: string): unknown[][] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args);
  }

  /** Call sequence, for asserting flow order. */
  get sequence(): string[] {
    return this.calls.map((c) => c.method);
  }

  async init(): Promise<void> {
    this.rec('init');
  }

  async getSolBalance(): Promise<number> {
    return this.sol;
  }

  async getUsdcBalance(): Promise<number> {
    return this.usdc;
  }

  /** The working pool's real tier. Override to exercise the price band. */
  async getPoolFeeRate(poolId: string): Promise<number | null> {
    this.rec('getPoolFeeRate', poolId);
    return this.poolFeeRate;
  }

  async getCurrentPrice(poolId?: string): Promise<number> {
    this.rec('getCurrentPrice', poolId);
    return this.price;
  }

  async swapSolToUsdc(solAmount: number, valueUsd?: number): Promise<SwapResult> {
    this.rec('swapSolToUsdc', solAmount, valueUsd);
    if (solAmount > this.sol) {
      throw new Error(`Fake: cannot sell ${solAmount} SOL, only ${this.sol} available`);
    }

    const quoted = solAmount * this.price;
    const received = quoted * (1 - this.swapFrictionBps / 10000);

    this.sol -= solAmount + this.networkFeeSol;
    this.usdc += received;

    const txId = `FAKE_S2U_${this.nextId++}`;
    this.effects.set(txId, {
      networkFeeSol: this.networkFeeSol,
      solDelta: -(solAmount + this.networkFeeSol),
      tokenDeltas: { [FakeLpClient.USDC_MINT]: received },
      rentDeposited: this.swapRentSol,
      rentReclaimed: this.swapRentSol,
    });

    return {
      txId,
      quote: {
        inAmount: String(Math.round(solAmount * 1e9)),
        outAmount: String(Math.round(quoted * 1e6)),
        priceImpactPct: '0',
        routePlan: [],
      },
    };
  }

  async swapUsdcToSol(usdcAmount: number, valueUsd?: number): Promise<SwapResult> {
    this.rec('swapUsdcToSol', usdcAmount, valueUsd);
    if (usdcAmount > this.usdc) {
      throw new Error(`Fake: cannot spend ${usdcAmount} USDC, only ${this.usdc} available`);
    }

    const quoted = usdcAmount / this.price;
    const received = quoted * (1 - this.swapFrictionBps / 10000);

    this.usdc -= usdcAmount;
    this.sol += received - this.networkFeeSol;

    const txId = `FAKE_U2S_${this.nextId++}`;
    this.effects.set(txId, {
      networkFeeSol: this.networkFeeSol,
      solDelta: received - this.networkFeeSol,
      tokenDeltas: { [FakeLpClient.USDC_MINT]: -usdcAmount },
      rentDeposited: this.swapRentSol,
      rentReclaimed: this.swapRentSol,
    });

    return {
      txId,
      quote: {
        inAmount: String(Math.round(usdcAmount * 1e6)),
        outAmount: String(Math.round(quoted * 1e9)),
        priceImpactPct: '0',
        routePlan: [],
      },
    };
  }

  /**
   * Effects of a transaction this fake performed.
   *
   * Null for an unknown signature, matching the real client's contract: a
   * caller that cannot read the effects must write no cost rows, because a
   * network_fee of 0 would assert the network charged nothing.
   */
  async getTransactionEffects(txId: string): Promise<TransactionEffects | null> {
    this.rec('getTransactionEffects', txId);
    return this.effects.get(txId) ?? null;
  }

  async createPosition(
    poolId: string,
    solAmount: number,
    usdcAmount: number,
    priceLower: number,
    priceUpper: number,
    _maxRetries?: number
  ): Promise<CreatePositionOutcome> {
    this.rec('createPosition', poolId, solAmount, usdcAmount, priceLower, priceUpper);

    if (priceLower >= priceUpper) {
      throw new Error(`Invalid price range: lower (${priceLower}) must be less than upper (${priceUpper})`);
    }

    const t = alignTicks(
      priceLower,
      priceUpper,
      this.price,
      this.decimalsA,
      this.decimalsB,
      this.tickSpacing,
      this.legacySizing ? 'floor' : 'contain'
    );

    let depositSol: number;
    let liquidity: number;
    let otherAmountMax: number;

    if (this.legacySizing) {
      // Pre-fix behaviour: all the SOL, and a cap taken from the wallet.
      depositSol = solAmount;
      liquidity = liquidityFromSol(solAmount, t.tickLower, t.tickUpper, t.tickCurrent, this.decimalsA);
      otherAmountMax = usdcAmount * (1 + this.slippage);
    } else {
      const plan = sizeDeposit({
        solAvailable: solAmount,
        usdcAvailable: usdcAmount,
        tickLower: t.tickLower,
        tickUpper: t.tickUpper,
        tickCurrent: t.tickCurrent,
        price: this.price,
        decimalsA: this.decimalsA,
        decimalsB: this.decimalsB,
        slippage: this.slippage,
      });
      depositSol = plan.solAmount;
      liquidity = plan.liquidity;
      otherAmountMax = plan.otherAmountMax;
    }

    // What the CLMM program itself computes, derived independently of the
    // sizing path so a drift between the two is caught rather than hidden.
    const requiredUsdc = usdcForLiquidity(liquidity, t.tickLower, t.tickUpper, t.tickCurrent, this.decimalsB);

    if (requiredUsdc > otherAmountMax) {
      // Mirrors the real anchor error, including the Left/Right operands, so
      // parseTransactionError sees exactly what mainnet produced.
      const left = Math.floor(otherAmountMax * Math.pow(10, this.decimalsB));
      const right = Math.floor(requiredUsdc * Math.pow(10, this.decimalsB));
      throw new Error(
        `Position creation failed: {"Custom":6017} PriceSlippageCheck. Left: ${left} Right: ${right}`
      );
    }

    if (requiredUsdc > this.usdc + 1e-9 || depositSol > this.sol + 1e-12) {
      throw new Error('Position creation failed: {"Custom":1} insufficient funds');
    }

    this.sol -= depositSol;
    this.usdc -= requiredUsdc;

    const nftMint = `FAKE_NFT_${this.nextId++}`;
    this.positions.set(nftMint, {
      nftMint,
      poolId,
      liquidity: String(Math.floor(liquidity)),
      tickLower: t.tickLower,
      tickUpper: t.tickUpper,
      priceLower: tickToPrice(t.tickLower, this.decimalsA, this.decimalsB),
      priceUpper: tickToPrice(t.tickUpper, this.decimalsA, this.decimalsB),
      currentPrice: this.price,
      amountA: depositSol,
      amountB: requiredUsdc,
      feeA: 0,
      feeB: 0,
      totalValueUsd: depositSol * this.price + requiredUsdc,
      inRange: true,
    });

    return {
      nftMint,
      txId: `FAKE_TX_${this.nextId++}`,
      solDeposited: depositSol,
      usdcDeposited: requiredUsdc,
    };
  }

  async closePosition(
    nftMint: string,
    _maxRetries?: number
  ): Promise<{ txId: string; decreaseTxId?: string; withdrewLiquidity: boolean }> {
    this.rec('closePosition', nftMint);
    const pos = this.positions.get(nftMint);
    if (!pos) throw new Error(`Fake: no such position ${nftMint}`);
    this.sol += pos.amountA;
    this.usdc += pos.amountB;
    this.positions.delete(nftMint);
    // Two signatures, like the real one: the tokens move in the decrease.
    return {
      txId: `FAKE_CLOSE_${this.nextId++}`,
      decreaseTxId: `FAKE_DECREASE_${this.nextId++}`,
      withdrewLiquidity: true,
    };
  }

  async getPositionDetails(nftMint: string): Promise<PositionDetails | null> {
    this.rec('getPositionDetails', nftMint);
    const pos = this.positions.get(nftMint);
    if (!pos) return null;
    return {
      ...pos,
      currentPrice: this.price,
      inRange: this.price > pos.priceLower && this.price < pos.priceUpper,
    };
  }

  async getMyPositions(): Promise<PositionSummary[]> {
    this.rec('getMyPositions');
    return [...this.positions.values()].map((p) => ({
      nftMint: p.nftMint,
      poolId: p.poolId,
      liquidity: p.liquidity,
      tickLower: p.tickLower,
      tickUpper: p.tickUpper,
      priceLower: p.priceLower,
      priceUpper: p.priceUpper,
    }));
  }

  /** Move the simulated market price, e.g. to push a position out of range. */
  setPrice(price: number): void {
    this.price = price;
  }

  /** Current SOL share of wallet value, net of a gas reserve. */
  solRatio(minSolReserve = 0): number {
    const solValue = Math.max(0, this.sol - minSolReserve) * this.price;
    return solValue / (solValue + this.usdc);
  }
}
