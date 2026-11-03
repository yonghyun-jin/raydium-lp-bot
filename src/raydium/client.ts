// Raydium CLMM client: the public entry point and the only class that signs
// or sends. Every send site (and its assertSendAllowed guard) stays in this
// file: tests/raydium/send-sites.test.ts and the other source-level guards
// read THIS file, so moving a send or a guarded method elsewhere would take it
// out of their sight without failing anything. Pure helpers live in ./client/.

import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  TransactionInstruction,
  AddressLookupTableAccount,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { Raydium, TxVersion,
  PositionUtils,
  TickArrayUtil,
  getPdaTickArrayAddress,
} from '@raydium-io/raydium-sdk-v2';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import BN from 'bn.js';
import { config, TOKENS } from './config';
import { JitoService } from './jito';
import { assertSendAllowed, SendBlockedError } from './guard';
import { LpClient, SwapQuote, SwapResult, SwapPriceGuard, TransactionEffects } from './LpClient';
import { attributeRent } from './rentAttribution';
import { checkQuotePrice, impliedPriceFromQuote } from './quotePrice';
import { JITO_TIP_ACCOUNTS } from './jito';
import { DurableTipMemory } from './durableTipMemory';
import { sizeDeposit } from './position-sizing';
import { tickToPrice, solForLiquidity, usdcForLiquidity } from './clmmMath';
import { parseTransactionError, ParsedTransactionError } from './errors';
import { withdrawalLanded, assertSafeToBurn } from './closeGuards';
import { JUPITER_API, CLMM_PROGRAM_ID } from './client/constants';
import { PoolInfo, fetchPoolInfo, getSolUsdcPools } from './client/pools';
import {
  tickToPrice as tickToPriceLegacy,
  readTickFromArray,
  priceToTick,
  findValidTickRange,
} from './client/ticks';
import { verifyTransaction, simulateBuiltTransaction } from './client/transactions';
import { getMyPositions, readPositionLiquidity } from './client/positions';
import { refineDepositWithSdk } from './client/deposit';

export class RaydiumClient implements LpClient {
  private connection: Connection;
  private wallet: Keypair;
  private raydium: Raydium | null = null;
  private jito: JitoService;
  private useJito: boolean;

  constructor(useJito: boolean = true) {
    this.connection = config.createConnection();
    this.wallet = config.loadWallet();
    // Durable tip memory, so the ladder's search for the cheapest tip that
    // lands survives a redeploy instead of restarting from the floor.
    this.jito = new JitoService(
      this.connection,
      this.wallet,
      undefined,
      new DurableTipMemory()
    );
    this.useJito = useJito;
  }

  /**
   * Initialize Raydium SDK
   */
  async init(): Promise<void> {
    console.log('Initializing Raydium SDK...');
    console.log(`RPC: ${config.network.RPC_URL}`);
    console.log(`Wallet: ${this.wallet.publicKey.toString()}`);

    this.raydium = await Raydium.load({
      connection: this.connection,
      owner: this.wallet,
      cluster: config.network.IS_DEVNET ? 'devnet' : 'mainnet',
      disableFeatureCheck: true,
      disableLoadToken: true,
      blockhashCommitment: 'confirmed',
    });

    console.log('Raydium SDK initialized!');
  }

  /**
   * Get Raydium instance (for direct SDK access)
   */
  getRaydium(): Raydium {
    if (!this.raydium) throw new Error('Raydium not initialized');
    return this.raydium;
  }

  /**
   * Get wallet public key
   */
  getWalletAddress(): string {
    return this.wallet.publicKey.toString();
  }

  /**
   * Get wallet SOL balance
   */
  async getSolBalance(): Promise<number> {
    const balance = await this.connection.getBalance(this.wallet.publicKey);
    return balance / 1e9; // lamports to SOL
  }

  /**
   * Wallet token balance. THROWS if it cannot be read.
   *
   * No token account is a real zero; a failed RPC call is UNKNOWN and must
   * throw, never return 0. A silent zero books phantom ledger losses/profits
   * from balance deltas and makes SwapToRatio sell SOL it did not need to sell
   * (a read that gates a spend, failing open). Throwing matches
   * `getSolBalance`; callers turn the failure into the null the ledger skips.
   */
  async getTokenBalance(mint: PublicKey): Promise<number> {
    const accounts = await this.connection.getTokenAccountsByOwner(
      this.wallet.publicKey,
      { mint }
    );

    // No token account is a real zero: the wallet has never held this mint.
    if (accounts.value.length === 0) return 0;

    const accountInfo = await this.connection.getTokenAccountBalance(
      accounts.value[0].pubkey
    );

    return parseFloat(accountInfo.value.uiAmountString || '0');
  }

  /**
   * Get USDC balance
   */
  async getUsdcBalance(): Promise<number> {
    const mint = config.network.IS_DEVNET ? TOKENS.USDC_DEV : TOKENS.USDC;
    return this.getTokenBalance(mint);
  }

  /**
   * What a landed transaction did to THIS wallet.
   *
   * Reads `getTransaction` once. That is the authoritative account of a single
   * transaction, and it is why this exists instead of bracketing a send with
   * balance reads: a bracket measures the wallet at two moments and blames
   * this transaction for everything that happened in between. The meta blames
   * only what the transaction did.
   *
   * `maxSupportedTransactionVersion` is REQUIRED, not optional tidiness.
   * Jupiter builds versioned transactions, so omitting it fails on exactly the
   * swaps this method exists to read -- and it fails by returning null, which
   * looks like "not found yet" rather than like a bug.
   *
   * Returns null rather than throwing or guessing. A caller that cannot read
   * the effects must write no cost rows at all; a `network_fee` row of 0 would
   * assert the network charged nothing.
   */
  async getTransactionEffects(txId: string): Promise<TransactionEffects | null> {
    try {
      // getParsedTransaction, not getTransaction: it returns the same meta AND
      // the instructions already decoded, including inner ones. Rent has to be
      // ATTRIBUTED to the account operations that actually happened -- taking
      // it as "the SOL left over" would make it a residual that silently
      // absorbs any cost nobody has modelled, which is the failure this whole
      // scope exists to prevent.
      const tx = await this.connection.getParsedTransaction(txId, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });

      if (!tx?.meta) {
        console.warn(`[Effects] ${txId} has no meta yet; reporting unknown.`);
        return null;
      }

      const me = this.wallet.publicKey.toString();
      const keys = tx.transaction.message.accountKeys;

      const index = keys.findIndex((k) => k.pubkey.toString() === me);
      if (index === -1) {
        console.warn(`[Effects] ${txId} does not touch this wallet directly.`);
        return null;
      }

      const solDelta = (tx.meta.postBalances[index] - tx.meta.preBalances[index]) / 1e9;

      // Token balances are reported per ACCOUNT, and one wallet can own several
      // accounts for the same mint, so deltas accumulate per mint rather than
      // overwrite. `uiTokenAmount.uiAmount` is null for a zeroed account.
      const before: Record<string, number> = {};
      for (const b of tx.meta.preTokenBalances ?? []) {
        if (b.owner !== me) continue;
        before[b.mint] = (before[b.mint] ?? 0) + (b.uiTokenAmount.uiAmount ?? 0);
      }

      const tokenDeltas: Record<string, number> = {};
      for (const b of tx.meta.postTokenBalances ?? []) {
        if (b.owner !== me) continue;
        tokenDeltas[b.mint] = (tokenDeltas[b.mint] ?? 0) + (b.uiTokenAmount.uiAmount ?? 0);
      }
      // A mint present before and absent after is a closed account, and its
      // whole balance left. Dropping it would hide the outflow entirely.
      for (const mint of Object.keys(before)) {
        tokenDeltas[mint] = (tokenDeltas[mint] ?? 0) - before[mint];
      }

      const { rentDeposited, rentReclaimed } = this.readRent(tx, me, keys);

      return {
        networkFeeSol: tx.meta.fee / 1e9,
        solDelta,
        tokenDeltas,
        rentDeposited,
        rentReclaimed,
      };
    } catch (error: any) {
      console.warn(`[Effects] ${txId} could not be read:`, error?.message ?? error);
      return null;
    }
  }

  /**
   * Rent this wallet left behind, and rent it got back.
   *
   * The rule itself lives in `attributeRent` -- it is pure arithmetic over
   * parsed instructions, and keeping it there is what makes it testable
   * without a wallet or an RPC, which is how two bugs in it were eventually
   * pinned down. This method only supplies the transaction's shape.
   */
  private readRent(
    tx: any,
    me: string,
    keys: Array<{ pubkey: { toString(): string } }>
  ): { rentDeposited: number; rentReclaimed: number } {
    const indexOf = (pubkey: string) => keys.findIndex((k) => k.pubkey.toString() === pubkey);
    const before = (pubkey: string) => {
      const i = indexOf(pubkey);
      return i === -1 ? 0 : (tx.meta.preBalances[i] ?? 0);
    };
    const after = (pubkey: string) => {
      const i = indexOf(pubkey);
      return i === -1 ? 0 : (tx.meta.postBalances[i] ?? 0);
    };

    // Inner instructions are not optional here -- see attributeRent.
    const instructions = [
      ...(tx.transaction.message.instructions ?? []),
      ...((tx.meta.innerInstructions ?? []).flatMap((i: any) => i.instructions ?? [])),
    ];

    // Tips are separated here, not swept into rent: a validator tip buys
    // inclusion and never comes back, while rent does.
    const { rentDeposited, rentReclaimed, tipPaid } = attributeRent(
      instructions,
      me,
      before,
      after,
      new Set(JITO_TIP_ACCOUNTS)
    );

    if (tipPaid > 0) {
      console.log(`[Effects] tip paid: ${tipPaid.toFixed(9)} SOL`);
    }

    return { rentDeposited, rentReclaimed };
  }


  /**
   * Fetch pool info directly from Raydium API
   */
  async fetchPoolInfo(poolId: string): Promise<PoolInfo | null> {
    return fetchPoolInfo(poolId);
  }

  /**
   * The pool's fee rate, or null.
   *
   * Null propagates rather than defaulting to 0: a fee of zero would WIDEN the
   * price band by understating what the trade legitimately costs, so guessing
   * it low is the dangerous direction.
   */
  async getPoolFeeRate(poolId: string): Promise<number | null> {
    try {
      const pool = await this.fetchPoolInfo(poolId);
      const rate = pool?.feeRate;
      return typeof rate === 'number' && Number.isFinite(rate) ? rate : null;
    } catch (error: any) {
      console.warn(`[Pool] fee rate unreadable:`, error?.message ?? error);
      return null;
    }
  }

  /** Get current price from pool */
  async getCurrentPrice(poolId?: string): Promise<number> {
    const id = poolId || config.pool.ID;
    if (!id) throw new Error('Pool ID not configured');

    const pool = await this.fetchPoolInfo(id);
    if (!pool) throw new Error('Failed to fetch pool info');

    return pool.price;
  }

  /**
   * Get pool information from SDK (on-chain)
   */
  async getPoolInfoFromChain(poolId: string): Promise<any> {
    if (!this.raydium) throw new Error('Raydium not initialized');

    try {
      const data = await this.raydium.clmm.getPoolInfoFromRpc(poolId);
      return data;
    } catch (e) {
      console.error('Error getting pool info from chain:', e);
      throw e;
    }
  }

  /**
   * Get SOL-USDC pools from API
   */
  async getSolUsdcPools(): Promise<any[]> {
    return getSolUsdcPools();
  }

  /** Decode a transaction error. See src/raydium/errors.ts. */
  private parseTransactionError(error: string): ParsedTransactionError {
    return parseTransactionError(error);
  }

  /** Poll a signature until it confirms, fails or times out. See client/transactions.ts. */
  private async verifyTransaction(
    txId: string,
    timeoutMs: number = 30000
  ): Promise<{
    success: boolean;
    error?: string;
    errorCode?: number;
    retryable?: boolean;
    explanation?: string;
  }> {
    return verifyTransaction(this.connection, txId, timeoutMs);
  }

  /** Current on-chain liquidity, null if gone; throws on RPC failure. See client/positions.ts. */
  private async readPositionLiquidity(nftMint: string): Promise<BN | null> {
    if (!this.raydium) throw new Error('Raydium not initialized');
    return readPositionLiquidity(this.raydium, nftMint);
  }

  private tickToPrice(tick: number, decimalsA: number, decimalsB: number): number {
    return tickToPriceLegacy(tick, decimalsA, decimalsB);
  }

  /**
   * Get all CLMM positions owned by wallet
   */
  async getMyPositions(): Promise<any[]> {
    if (!this.raydium) throw new Error('Raydium not initialized');
    return getMyPositions(this.raydium, (poolId) => this.fetchPoolInfo(poolId));
  }

  /**
   * Get detailed position info including current amounts and fees
   */
  async getPositionDetails(nftMint: string): Promise<{
    nftMint: string;
    poolId: string;
    liquidity: string;
    tickLower: number;
    tickUpper: number;
    priceLower: number;
    priceUpper: number;
    currentPrice: number;
    amountA: number;  // SOL
    amountB: number;  // USDC
    feeA: number | null;  // Pending SOL fees, null when they cannot be read
    feeB: number | null;  // Pending USDC fees, null when they cannot be read
    totalValueUsd: number;
    inRange: boolean;
  } | null> {
    if (!this.raydium) throw new Error('Raydium not initialized');

      const positions = await this.raydium.clmm.getOwnerPositionInfo({
        programId: new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'),
      });

      const pos = positions.find((p: any) => p.nftMint?.toString() === nftMint);
      if (!pos) return null;

      const poolId = pos.poolId?.toString() || '';
      const poolInfo = await this.fetchPoolInfo(poolId);
      if (!poolInfo) {
        // Do NOT return null here: callers read null as "position not found
        // on-chain", which is only true of the `!pos` case above. An
        // unreadable POOL must throw so it reads as "failed to read position".
        throw new Error(
          `Pool ${poolId} could not be read, so position ${nftMint} cannot be priced. ` +
            `The position itself is untouched.`
        );
      }

      const poolData = await this.raydium.clmm.getPoolInfoFromRpc(poolId);

      // Prices from ticks, using the shared CLMM maths.
      const decimalsA = poolInfo.mintA.decimals;
      const decimalsB = poolInfo.mintB.decimals;
      const priceLower = tickToPrice(pos.tickLower, decimalsA, decimalsB);
      const priceUpper = tickToPrice(pos.tickUpper, decimalsA, decimalsB);

      // Use the ON-CHAIN tick, not poolInfo.tickCurrent: the API value can be
      // stale, and a wrong inRange drives wrong rebalance decisions.
      const onChain = poolData.poolInfo as any;
      const tickCurrent: number =
        typeof onChain?.tickCurrent === 'number' ? onChain.tickCurrent : poolInfo.tickCurrent;
      const currentPrice = tickToPrice(tickCurrent, decimalsA, decimalsB);

      // Amounts from liquidity. No decimal fudge factor belongs here (a
      // spurious 10^((decB-decA)/2) term once inflated amounts by 10^1.5).
      const liquidity = parseFloat(pos.liquidity?.toString() || '0');
      const amountA = solForLiquidity(liquidity, pos.tickLower, pos.tickUpper, tickCurrent, decimalsA);
      const amountB = usdcForLiquidity(liquidity, pos.tickLower, pos.tickUpper, tickCurrent, decimalsB);

      // Pending fees. NOT pos.tokenFeesOwed -- see fetchPendingFees.
      const fees = await this.fetchPendingFees(
        pos,
        poolData.computePoolInfo,
        poolId,
        decimalsA,
        decimalsB
      );
      const feeA = fees ? fees.feeA : null;
      const feeB = fees ? fees.feeB : null;

      // Principal is known even when fees are not. Unknown fees are OMITTED
      // from the total rather than guessed at zero; the caller that reports
      // fees to the operator reads feeA/feeB and says "unknown" for null.
      const totalValueUsd =
        amountA * currentPrice + amountB + (feeA ?? 0) * currentPrice + (feeB ?? 0);
      const inRange = tickCurrent >= pos.tickLower && tickCurrent < pos.tickUpper;

      return {
        nftMint,
        poolId,
        liquidity: pos.liquidity?.toString() || '0',
        tickLower: pos.tickLower,
        tickUpper: pos.tickUpper,
        priceLower,
        priceUpper,
        currentPrice,
        amountA,
        amountB,
        feeA,
        feeB,
        totalValueUsd,
        inRange,
      };
  }

  /**
   * Pending fees for a position, in UI units. Null when they cannot be read.
   *
   * `tokenFeesOwed` on the position account is a CHECKPOINT, not a running
   * total. CLMM settles fees into it only when the position is TOUCHED
   * (increase/decrease liquidity, or collect), so an earning position reads 0
   * there until something moves it.
   *
   * The live figure is the checkpoint plus the growth accrued since it was
   * taken:
   *
   *   fees = tokenFeesOwed
   *        + liquidity x (feeGrowthInside_now - feeGrowthInsideLast) / 2^64
   *
   * `feeGrowthInside` is stored nowhere. It is the pool's feeGrowthGlobal minus
   * the feeGrowthOutside of BOTH boundary ticks, which is why this needs the two
   * tick-array accounts and not just the position account. The SDK implements
   * exactly this in PositionUtils.GetPositionFees -- use it rather than
   * re-deriving the maths, and note its subtraction is wrapping (U128), so an
   * out-of-range position cannot produce a negative fee.
   *
   * Returns null rather than 0 when an input is missing: "unknown" and "none"
   * are different answers, and a wrong $0.00 looks convincing.
   */
  private async fetchPendingFees(
    position: any,
    computePoolInfo: any,
    poolId: string,
    decimalsA: number,
    decimalsB: number
  ): Promise<{ feeA: number; feeB: number } | null> {
    try {
      const tickSpacing: number = computePoolInfo?.tickSpacing;
      if (typeof tickSpacing !== 'number' || tickSpacing <= 0) {
        console.warn('[Fees] pool tickSpacing unavailable; fees unknown');
        return null;
      }

      const programId = new PublicKey(CLMM_PROGRAM_ID);
      const pool = new PublicKey(poolId);

      // The boundary ticks live in whichever tick array covers each of them,
      // which is not necessarily the array around the current price.
      const lowerStart = TickArrayUtil.getTickArrayStartIndex(position.tickLower, tickSpacing);
      const upperStart = TickArrayUtil.getTickArrayStartIndex(position.tickUpper, tickSpacing);

      const accounts = await this.connection.getMultipleAccountsInfo([
        getPdaTickArrayAddress(programId, pool, lowerStart).publicKey,
        getPdaTickArrayAddress(programId, pool, upperStart).publicKey,
      ]);

      const lowerTick = this.readTickFromArray(accounts[0], position.tickLower, tickSpacing);
      const upperTick = this.readTickFromArray(accounts[1], position.tickUpper, tickSpacing);
      if (!lowerTick || !upperTick) {
        // An open position's boundary ticks are initialized by construction, so
        // this is an anomaly -- a failed RPC read or a wrong PDA -- and not a
        // position that has simply earned nothing.
        console.warn('[Fees] boundary tick accounts unreadable; fees unknown');
        return null;
      }

      const { tokenFeeAmountA, tokenFeeAmountB } = PositionUtils.GetPositionFees(
        computePoolInfo,
        position,
        lowerTick,
        upperTick
      );

      return {
        feeA: parseFloat(tokenFeeAmountA.toString()) / Math.pow(10, decimalsA),
        feeB: parseFloat(tokenFeeAmountB.toString()) / Math.pow(10, decimalsB),
      };
    } catch (e) {
      console.warn('[Fees] could not compute pending fees:', e instanceof Error ? e.message : e);
      return null;
    }
  }

  private readTickFromArray(
    account: { data: Buffer } | null,
    tick: number,
    tickSpacing: number
  ): any | null {
    return readTickFromArray(account, tick, tickSpacing);
  }

  private priceToTick(price: number, decimalsA: number, decimalsB: number, tickSpacing: number): number {
    return priceToTick(price, decimalsA, decimalsB, tickSpacing);
  }

  /** Narrow a range to initialized tick arrays. See client/ticks.ts. */
  async findValidTickRange(
    poolId: string,
    tickCurrent: number,
    desiredTickLower: number,
    desiredTickUpper: number,
    tickSpacing: number
  ): Promise<{ tickLower: number; tickUpper: number; adjusted: boolean }> {
    return findValidTickRange(this.connection, poolId, tickCurrent, desiredTickLower, desiredTickUpper, tickSpacing);
  }

  /**
   * Create a new CLMM position with progressive slippage retry
   * Starts with minimal slippage and increases only if needed (error 6017)
   *
   * @param poolId - Pool ID
   * @param solAmount - SOL amount to deposit
   * @param usdcAmount - USDC amount to deposit
   * @param priceLower - Lower bound price (e.g., $95)
   * @param priceUpper - Upper bound price (e.g., $105)
   * @param maxRetries - Maximum retry attempts (default 5)
   */
  async createPosition(
    poolId: string,
    solAmount: number,
    usdcAmount: number,
    priceLower: number,
    priceUpper: number,
    maxRetries: number = 5
  ): Promise<{ nftMint: string; txId: string; solDeposited: number; usdcDeposited: number }> {
    if (!this.raydium) throw new Error('Raydium not initialized');

    // Validate price range
    if (priceLower >= priceUpper) {
      throw new Error(`Invalid price range: lower (${priceLower}) must be less than upper (${priceUpper})`);
    }

    // Progressive slippage: start low, increase only on slippage errors
    // Values in decimal (0.001 = 0.1%)
    const slippageSteps = [0.001, 0.003, 0.005, 0.01, 0.02];
    let slippageIndex = 0;
    let lastError: Error | null = null;
    let lastExplanation: string = '';

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const currentSlippage = slippageSteps[Math.min(slippageIndex, slippageSteps.length - 1)];
      console.log(`\n=== Position creation attempt ${attempt}/${maxRetries} (slippage: ${(currentSlippage * 100).toFixed(1)}%) ===`);

      try {
        const result = await this.createPositionAttempt(poolId, solAmount, usdcAmount, priceLower, priceUpper, currentSlippage);
        console.log(`✅ Position created successfully on attempt ${attempt} with ${(currentSlippage * 100).toFixed(1)}% slippage!`);
        return result;
      } catch (error: any) {
        // A policy refusal is a decision, not a transient failure. Rewrapping it
        // as `[Error UNKNOWN] ...` destroys the type callers branch on and buries
        // the actual reason ("ALLOW_REAL_MONEY is not set") behind a code that
        // suggests something went wrong on-chain.
        if (error instanceof SendBlockedError) {
          throw error;
        }

        const errorStr = error?.message || String(error);
        const parsed = this.parseTransactionError(errorStr);

        console.error(`❌ Attempt ${attempt} failed:`);
        console.error(`   Error: ${parsed.errorMessage}`);
        console.error(`   Code: ${parsed.errorCode || 'N/A'}`);
        console.error(`   Explanation: ${parsed.explanation}`);
        console.error(`   Retryable: ${parsed.retryable}`);

        lastError = error;
        lastExplanation = parsed.explanation;

        // For slippage errors (6017), increase slippage for next attempt
        if (parsed.errorCode === 6017) {
          slippageIndex++;
          console.log(`   Slippage error - will retry with higher tolerance`);
        }

        if (!parsed.retryable) {
          throw new Error(`[Error ${parsed.errorCode || 'UNKNOWN'}] ${parsed.explanation}`);
        }

        if (attempt < maxRetries) {
          const waitTime = 2000; // Short wait between retries
          console.log(`   Waiting ${waitTime / 1000}s before retry...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    }

    throw new Error(`Failed after ${maxRetries} attempts. Last error: ${lastExplanation || lastError?.message}`);
  }

  /**
   * Reconcile the pool's reward accounts so `decreaseLiquidity` builds a valid
   * instruction.
   *
   * WHY THIS EXISTS: `getPoolInfoFromRpc` hardcodes `rewardDefaultInfos: []`,
   * but the SDK pairs reward vaults to owner accounts by walking exactly that
   * array:
   *
   *     for (i < poolInfo.rewardDefaultInfos.length)        // empty -> no entries
   *       map.set(rewardDefaultInfos[i].mint.address, ownerInfo.rewardAccounts[i]);
   *     for (i < poolKeys.rewardInfos.length)               // 1 entry for this pool
   *       if (map.get(mint)) push(rewardAccount);           // never true
   *
   * So it attaches ZERO reward accounts while the program expects one, and
   * decrease_liquidity.rs:517 rejects the transaction with error 6030
   * InvalidRewardInputAccountNumber. The working SOL-USDC pool has a RAY reward
   * slot (ended, but still initialised), so every close hits this.
   *
   * The fix is to rebuild `rewardDefaultInfos` from `poolKeys.rewardInfos`,
   * which the RPC path DOES populate correctly, and to supply the matching
   * owner token accounts in the same order.
   */
  private buildRewardAccounts(poolData: any): { poolInfo: any; rewardAccounts: PublicKey[] } {
    const keyRewards: any[] = poolData?.poolKeys?.rewardInfos ?? [];

    if (keyRewards.length === 0) {
      // A pool with no reward slots needs no reconciliation.
      return { poolInfo: poolData.poolInfo, rewardAccounts: [] };
    }

    const rewardAccounts = keyRewards.map((reward: any) => {
      const mint = new PublicKey(reward.mint.address);
      const programId = new PublicKey(reward.mint.programId);
      return getAssociatedTokenAddressSync(mint, this.wallet.publicKey, true, programId);
    });

    console.log(
      `Reward accounts: ${keyRewards.length} reward slot(s) on this pool ` +
        `(${keyRewards.map((r: any) => r.mint.address.slice(0, 6)).join(', ')})`
    );

    return {
      // Only `.mint.address` is read from these entries, but keep the whole
      // token object so the shape stays recognisable to anything else.
      poolInfo: {
        ...poolData.poolInfo,
        rewardDefaultInfos: keyRewards.map((r: any) => ({ mint: r.mint })),
      },
      rewardAccounts,
    };
  }

  /** Simulate an SDK build result without sending. See client/transactions.ts. */
  private async simulateBuiltTransaction(sdkResult: any, label: string): Promise<void> {
    return simulateBuiltTransaction(this.connection, this.wallet.publicKey, sdkResult, label);
  }

  /** Fit a deposit to the SDK's integer maths. See client/deposit.ts. */
  private async refineDepositWithSdk(params: {
    poolInfo: any;
    epochInfo: any;
    tickLower: number;
    tickUpper: number;
    solAmount: number;
    usdcAvailable: number;
    slippage: number;
    decimalsA: number;
    decimalsB: number;
  }): Promise<{ baseAmount: BN; otherAmountMax: BN; liquidity: BN; solAmount: number; requiredUsdc: number }> {
    return refineDepositWithSdk(params);
  }

  /**
   * Single attempt to create a CLMM position (internal)
   *
   * @param poolId - Pool ID
   * @param solAmount - SOL amount to deposit
   * @param usdcAmount - USDC amount to deposit
   * @param priceLower - Lower bound price
   * @param priceUpper - Upper bound price
   * @param slippageTolerance - Slippage tolerance (default 0.5%)
   */

  private async createPositionAttempt(
    poolId: string,
    solAmount: number,
    usdcAmount: number,
    priceLower: number,
    priceUpper: number,
    slippageTolerance: number = 0.005
  ): Promise<{ nftMint: string; txId: string; solDeposited: number; usdcDeposited: number }> {
    if (!this.raydium) throw new Error('Raydium not initialized');

    // Get pool info from API
    const poolInfo = await this.fetchPoolInfo(poolId);
    if (!poolInfo) throw new Error('Failed to fetch pool info');

    // Get full pool data from chain
    const poolData = await this.raydium.clmm.getPoolInfoFromRpc(poolId);

    const currentPrice = poolInfo.price;

    // Calculate ticks from provided prices (asymmetric ranges supported)
    const tickLower = this.priceToTick(
      priceLower,
      poolInfo.mintA.decimals,
      poolInfo.mintB.decimals,
      poolInfo.tickSpacing
    );
    const tickUpper = this.priceToTick(
      priceUpper,
      poolInfo.mintA.decimals,
      poolInfo.mintB.decimals,
      poolInfo.tickSpacing
    );

    console.log(`Creating position:`);
    console.log(`  Price range: $${priceLower.toFixed(4)} - $${priceUpper.toFixed(4)}`);
    console.log(`  Tick range: ${tickLower} - ${tickUpper}`);
    console.log(`  Amounts: ${solAmount.toFixed(4)} SOL, ${usdcAmount.toFixed(2)} USDC`);

    // Get current tick from on-chain data (API tickCurrent may be stale/wrong)
    const onChainPoolInfo = poolData.poolInfo as any;
    const tickCurrent = onChainPoolInfo.tickCurrent || poolInfo.tickCurrent || 0;

    console.log(`  On-chain tickCurrent: ${tickCurrent}`);
    console.log(`  API tickCurrent: ${poolInfo.tickCurrent}`);
    console.log(`  Tick range: ${tickLower} to ${tickUpper}`);

    // Find valid tick range within initialized tick arrays
    console.log(`\nChecking tick array initialization...`);
    let finalTickLower = tickLower;
    let finalTickUpper = tickUpper;

    try {
      const validRange = await this.findValidTickRange(
        poolId,
        tickCurrent,
        tickLower,
        tickUpper,
        poolInfo.tickSpacing
      );
      finalTickLower = validRange.tickLower;
      finalTickUpper = validRange.tickUpper;

      if (validRange.adjusted) {
        // Recalculate prices for adjusted range
        const newPriceLower = this.tickToPrice(finalTickLower, poolInfo.mintA.decimals, poolInfo.mintB.decimals);
        const newPriceUpper = this.tickToPrice(finalTickUpper, poolInfo.mintA.decimals, poolInfo.mintB.decimals);
        console.log(`📊 Adjusted price range: $${newPriceLower.toFixed(4)} - $${newPriceUpper.toFixed(4)}`);
      }
    } catch (tickArrayError: any) {
      console.error(`❌ Tick array check failed: ${tickArrayError?.message}`);
      throw new Error(`Cannot create position: ${tickArrayError?.message}`);
    }

    // Solve for a deposit the pool will actually accept.
    //
    // This MUST run after findValidTickRange: tick alignment (and any
    // narrowing) changes how much USDC the position needs. otherAmountMax must
    // come from the position's requirement, never from the wallet balance --
    // that (plus a spurious 10^1.5 liquidity factor) caused repeated 6017
    // PriceSlippageCheck failures.
    const decimalsA = poolInfo.mintA.decimals;
    const decimalsB = poolInfo.mintB.decimals;

    const plan = sizeDeposit({
      solAvailable: solAmount,
      usdcAvailable: usdcAmount,
      tickLower: finalTickLower,
      tickUpper: finalTickUpper,
      tickCurrent,
      price: currentPrice,
      decimalsA,
      decimalsB,
      slippage: slippageTolerance,
    });

    // Refine against the SDK's integer maths before committing to numbers.
    const epochInfo = await this.raydium.fetchEpochInfo();
    const refined = await this.refineDepositWithSdk({
      poolInfo: poolData.poolInfo,
      epochInfo,
      tickLower: finalTickLower,
      tickUpper: finalTickUpper,
      solAmount: plan.solAmount,
      usdcAvailable: usdcAmount,
      slippage: slippageTolerance,
      decimalsA,
      decimalsB,
    });

    const liquidity = refined.liquidity;
    const depositSolBN = refined.baseAmount;
    const otherAmountMaxWithSlippage = refined.otherAmountMax;
    const depositedSol = refined.solAmount;
    const depositedUsdc = refined.requiredUsdc;

    const positionValueUsd = depositedSol * currentPrice + depositedUsdc;

    console.log(`  Sizing (limited by ${plan.limitedBy}):`);
    console.log(`    Deposit:        ${depositedSol.toFixed(6)} SOL + ${depositedUsdc.toFixed(6)} USDC`);
    console.log(`    Position value: $${(depositedSol * currentPrice + depositedUsdc).toFixed(2)}`);
    console.log(`    Required USDC:  ${depositedUsdc.toFixed(6)} (float estimate was ${plan.requiredUsdc.toFixed(6)})`);
    console.log(`    otherAmountMax: ${(Number(otherAmountMaxWithSlippage.toString()) / Math.pow(10, decimalsB)).toFixed(6)} (available ${usdcAmount.toFixed(6)})`);
    console.log(`    Liquidity:      ${liquidity.toString()}`);
    console.log(`  Slippage tolerance: ${(slippageTolerance * 100).toFixed(1)}%`);

    const openPositionResult = await this.raydium.clmm.openPositionFromBase({
      poolInfo: poolData.poolInfo,
      poolKeys: poolData.poolKeys,
      tickLower: finalTickLower,
      tickUpper: finalTickUpper,
      base: 'MintA', // Base on SOL
      baseAmount: depositSolBN,
      otherAmountMax: otherAmountMaxWithSlippage,
      liquidity,
      ownerInfo: {
        useSOLBalance: true,
      },
      txVersion: TxVersion.V0,
      computeBudgetConfig: {
        units: 600000,
        microLamports: 500000, // Higher priority
      },
    });

    const { execute, extInfo } = openPositionResult;

    // DRY_RUN: build the real transaction and simulate it, but never send.
    // Real pool state, tick arrays, balances, liquidity and otherAmountMax are
    // all exercised, so a clean simulation means the transaction would land.
    if (config.safety.DRY_RUN) {
      await this.simulateBuiltTransaction(openPositionResult, 'createPosition');
      return {
        nftMint: extInfo.nftMint.toString(),
        txId: 'DRY_RUN',
        solDeposited: depositedSol,
        usdcDeposited: depositedUsdc,
      };
    }

    // Execute transaction - try SDK execute first, then manual fallback
    console.log('Executing transaction...');
    let txId: string;

    try {
      // Try SDK execute first
      assertSendAllowed('createPosition: SDK execute', positionValueUsd);
      const result = await execute({ sendAndConfirm: false }); // Don't wait for confirm
      console.log('Execute result type:', typeof result);

      if (result && result.txId) {
        txId = result.txId;
        console.log('Got txId from execute:', txId);

        // IMPORTANT: Verify transaction succeeded on-chain
        console.log('Verifying transaction on-chain...');
        const txStatus = await this.verifyTransaction(txId, 30000);
        if (!txStatus.success) {
          // Include error code in message so retry logic can parse it
          const errorCode = txStatus.errorCode;
          const errorMsg = txStatus.explanation || txStatus.error || 'Unknown error';
          // Format with {"Custom":CODE} so parseTransactionError can extract it
          const fullError = errorCode ? `{"Custom":${errorCode}} ${errorMsg}` : errorMsg;
          throw new Error(fullError);
        }
        console.log('Transaction verified successfully!');
      } else if (result && (result as any).txIds?.length > 0) {
        txId = (result as any).txIds[0];
        console.log('Got txId from txIds array:', txId);

        // IMPORTANT: Verify transaction succeeded on-chain
        console.log('Verifying transaction on-chain...');
        const txStatus = await this.verifyTransaction(txId, 30000);
        if (!txStatus.success) {
          // Include error code in message so retry logic can parse it
          const errorCode = txStatus.errorCode;
          const errorMsg = txStatus.explanation || txStatus.error || 'Unknown error';
          // Format with {"Custom":CODE} so parseTransactionError can extract it
          const fullError = errorCode ? `{"Custom":${errorCode}} ${errorMsg}` : errorMsg;
          throw new Error(fullError);
        }
        console.log('Transaction verified successfully!');
      } else {
        // SDK execute didn't return txId - try manual approach
        console.log('SDK execute returned no txId, trying manual build...');

        // Check if we can get builder from the result
        const openResult = await this.raydium!.clmm.openPositionFromBase({
          poolInfo: poolData.poolInfo,
          poolKeys: poolData.poolKeys,
          tickLower: finalTickLower,
          tickUpper: finalTickUpper,
          base: 'MintA',
          baseAmount: depositSolBN,
          otherAmountMax: otherAmountMaxWithSlippage,
          liquidity,
          ownerInfo: {
            useSOLBalance: true,
          },
          txVersion: TxVersion.V0,
          computeBudgetConfig: {
            units: 600000,
            microLamports: 500000,
          },
        });

        // Get builder and build transaction
        const builder = (openResult as any).builder;
        if (!builder) {
          throw new Error('No builder available from SDK');
        }

        // Build fresh transactions
        const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
        console.log('Got blockhash:', blockhash.slice(0, 20) + '...');

        const allInstructions = builder.allInstructions;
        console.log(`Building transaction with ${allInstructions.length} instructions`);

        const lookupTableAddresses: PublicKey[] = builder.lookupTableAddress || [];
        let lookupTableAccounts: AddressLookupTableAccount[] = [];

        if (lookupTableAddresses.length > 0) {
          const results = await Promise.all(
            lookupTableAddresses.map(async (addr: PublicKey) => {
              const result = await this.connection.getAddressLookupTable(addr);
              return result.value;
            })
          );
          lookupTableAccounts = results.filter((a): a is AddressLookupTableAccount => a !== null);
        }

        const message = new TransactionMessage({
          payerKey: this.wallet.publicKey,
          recentBlockhash: blockhash,
          instructions: allInstructions,
        });
        const messageV0 = message.compileToV0Message(lookupTableAccounts);
        const transaction = new VersionedTransaction(messageV0);

        // Sign and send
        const signers = (openResult as any).signers || [];
        assertSendAllowed('createPosition: manual fallback send', positionValueUsd);
        transaction.sign([this.wallet, ...signers]);

        txId = await this.connection.sendTransaction(transaction, {
          skipPreflight: true,
          maxRetries: 3,
        });
        console.log('Transaction sent:', txId);

        // Verify on-chain, the same way the SDK path does. A txId means
        // submitted, not landed: never return success without this check.
        console.log('Verifying transaction on-chain...');
        const manualStatus = await this.verifyTransaction(txId, 60000);
        if (!manualStatus.success) {
          const errorMsg = manualStatus.explanation || manualStatus.error || 'Unknown error';
          // Keep the code parseable so the retry ladder can act on it.
          throw new Error(
            manualStatus.errorCode ? `{"Custom":${manualStatus.errorCode}} ${errorMsg}` : errorMsg
          );
        }
        console.log('Transaction verified successfully!');
      }
    } catch (execError: any) {
      console.error('Execute error:', execError?.message || execError);
      throw new Error(`Position creation failed: ${execError?.message || execError?.toString?.() || 'Unknown error'}`);
    }

    if (!txId) {
      throw new Error('Failed to get transaction ID');
    }

    console.log(`Position created! TX: ${txId}`);
    console.log(`NFT Mint: ${extInfo.nftMint.toString()}`);

    return {
      nftMint: extInfo.nftMint.toString(),
      txId,
      solDeposited: depositedSol,
      usdcDeposited: depositedUsdc,
    };
  }

  /**
   * Close/withdraw from a CLMM position with retry logic
   */
  async closePosition(
    nftMint: string,
    maxRetries: number = 3
  ): Promise<{ txId: string; decreaseTxId?: string; withdrewLiquidity: boolean }> {
    if (!this.raydium) throw new Error('Raydium not initialized');

    console.log(`Closing position: ${nftMint}`);

    // Survives across attempts. Once a burn has been broadcast, "position not
    // found" on a later attempt is evidence of SUCCESS, not failure -- reporting
    // it as a failure leaves the caller recording a closed position as open.
    let burnTxId: string | undefined;

    // A close is TWO transactions and the caller needs both signatures: the
    // money moves in the decrease, only rent moves in the burn, so the ledger
    // cannot reconcile the close against the burn alone. Survives across
    // attempts for the same reason burnTxId does.
    let decreaseTxId: string | undefined;

    // Whether there was ever any liquidity to take out. An empty position is
    // closed by the burn ALONE; keep that distinct from a decrease whose
    // signature was lost, or the ledger warns about a withdrawal that never
    // happened.
    let withdrewLiquidity = false;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`Attempt ${attempt}/${maxRetries}...`);

        // Get FRESH position info each attempt
        const positions = await this.raydium.clmm.getOwnerPositionInfo({
          programId: new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'),
        });

        const position = positions.find((p: any) => p.nftMint.toString() === nftMint);
        if (!position) {
          if (burnTxId) {
            console.log(`Position is gone and burn ${burnTxId} was broadcast -- the close succeeded.`);
            return { txId: burnTxId, decreaseTxId, withdrewLiquidity };
          }
          throw new Error('Position not found');
        }

        // Get FRESH pool info with RPC data
        const poolId = position.poolId.toString();
        const poolData = await this.raydium.clmm.getPoolInfoFromRpc(poolId);

        // Small delay to ensure data is fresh
        await new Promise(resolve => setTimeout(resolve, 500));

        // First decrease liquidity to 0
        if (position.liquidity.gt(new BN(0))) {
          withdrewLiquidity = true;
          console.log(`Decreasing liquidity: ${position.liquidity.toString()}...`);

          // Note: amountMinA/B = 0 allows full slippage, but CLMM withdrawals
          // are based on your liquidity share, not market orders.
          // The main risk is price movement between submit and confirm.
          // For safety, we use high priority fee for faster confirmation.

          // Without this the instruction carries no reward accounts and the
          // program rejects it with 6030. See buildRewardAccounts().
          const { poolInfo: rewardAwarePoolInfo, rewardAccounts } =
            this.buildRewardAccounts(poolData);

          const decreaseLiquidityResult = await this.raydium.clmm.decreaseLiquidity({
            poolInfo: rewardAwarePoolInfo,
            poolKeys: poolData.poolKeys,
            ownerPosition: position,
            liquidity: position.liquidity,
            amountMinA: new BN(0),
            amountMinB: new BN(0),
            // `rewardAccounts` is missing from the SDK's ownerInfo TYPE but is
            // read by its implementation (`o.rewardAccounts[B]`). Verified by
            // simulating the built transaction: clean, 50,284 compute units.
            ownerInfo: {
              useSOLBalance: true,
              rewardAccounts,
            } as any,
            txVersion: TxVersion.V0,
            computeBudgetConfig: {
              units: 600000, // Increased compute units
              microLamports: 500000, // Higher priority for faster confirmation
            },
          });

          if (!decreaseLiquidityResult) {
            throw new Error('decreaseLiquidity returned null/undefined');
          }

          // Log the SDK result structure for debugging
          console.log('SDK result keys:', Object.keys(decreaseLiquidityResult));
          console.log('Has execute:', typeof (decreaseLiquidityResult as any).execute);
          console.log('Has builder:', !!(decreaseLiquidityResult as any).builder);

          // DRY_RUN: rehearse the withdrawal, then refuse before anything is sent.
          // This deliberately THROWS rather than returning a synthetic success:
          // a dry run must never produce a result a real run would produce, or a
          // caller marks a position CLOSED while it still holds real money.
          if (config.safety.DRY_RUN) {
            await this.simulateBuiltTransaction(
              decreaseLiquidityResult,
              'closePosition: decreaseLiquidity'
            );
            throw new SendBlockedError(
              '[GUARD] DRY_RUN: decreaseLiquidity simulated cleanly and was NOT sent. ' +
                'The position is unchanged and still holds liquidity. ' +
                'Re-run with ALLOW_REAL_MONEY=true --execute to close it for real.'
            );
          }

          // Gate every send in this block -- SDK execute AND the manual fallbacks
          // below -- on one guard call. No valueUsd: closing RECOVERS funds, so
          // capping it by MAX_POSITION_USD would block closing exactly the
          // oversized position you most need to get out of.
          assertSendAllowed('closePosition: decreaseLiquidity');

          console.log('Executing decreaseLiquidity transaction...');
          let decreaseResult;
          try {
            // Try SDK execute first - use sendAndConfirm: false for faster response
            if (typeof (decreaseLiquidityResult as any).execute === 'function') {
              try {
                console.log('Calling SDK execute with sendAndConfirm: false...');
                const executePromise = (decreaseLiquidityResult as any).execute({ sendAndConfirm: false });
                const timeoutPromise = new Promise((_, reject) =>
                  setTimeout(() => reject(new Error('Transaction execution timeout after 15s')), 15000)
                );

                const executeResult = await Promise.race([executePromise, timeoutPromise]);
                console.log('SDK execute result:', JSON.stringify(executeResult, null, 2));

                // Check if we got transaction IDs
                if (executeResult && typeof executeResult === 'object') {
                  const txIds = executeResult.txIds || executeResult.txId || [];
                  const txIdArray = Array.isArray(txIds) ? txIds : [txIds];

                  if (txIdArray.length > 0 && txIdArray[0]) {
                    console.log(`Transaction(s) sent via SDK: ${txIdArray.join(', ')}`);

                    // EVERY transaction must land, not just the first: the SDK
                    // can split decreaseLiquidity, and stopping at the first
                    // confirmation calls a partial withdrawal complete.
                    let allConfirmed = true;
                    for (const txId of txIdArray) {
                      console.log(`Waiting for ${txId} to confirm...`);
                      const confirmation = await this.verifyTransaction(txId, 45000);
                      if (!confirmation.success) {
                        console.log(
                          `Not confirmed: ${confirmation.explanation ?? confirmation.error}`
                        );
                        allConfirmed = false;
                        break;
                      }
                      console.log(`Transaction confirmed: ${txId}`);
                    }

                    if (allConfirmed) {
                      decreaseResult = { txId: txIdArray[0] };
                    } else {
                      // Never treat an unconfirmed signature as success: it would
                      // fall through to BURNING the position NFT. It may still
                      // land, so guessing either way is wrong. Ask the chain.
                      const liquidity = await this.readPositionLiquidity(nftMint);
                      if (withdrawalLanded(false, liquidity)) {
                        console.log('Liquidity is zero on-chain -- the withdrawal landed after all.');
                        decreaseResult = { txId: txIdArray[0] };
                      } else {
                        // Leave decreaseResult unset so the manual path below
                        // genuinely retries the send.
                        console.log(
                          `Withdrawal unconfirmed and liquidity is still ` +
                            `${liquidity?.toString() ?? 'unreadable'} -- not treating it as done.`
                        );
                      }
                    }
                  }
                }

                // Do NOT add a fallback that sets decreaseResult from
                // executeResult.txId: that signature is already in txIdArray,
                // so such a fallback only fires for one the confirmation check
                // just REJECTED, restoring the invented success.
              } catch (sdkError: any) {
                console.log(`SDK execute failed: ${sdkError?.message || sdkError}`);
                decreaseResult = undefined;

                // The 15s race abandons execute()'s promise, which is the ONLY
                // record of a signature the SDK may already have broadcast.
                // Re-sending blindly costs a priority fee and can end in a
                // spurious failure, so ask the chain first.
                const liquidity = await this.readPositionLiquidity(nftMint);
                if (withdrawalLanded(false, liquidity)) {
                  console.log('Liquidity is zero on-chain -- the abandoned send landed. Not re-sending.');
                  decreaseResult = { txId: undefined };
                }
              }
            }

            // If SDK execute failed or returned no txId, try manual send
            // Keyed on "are we done", NOT on "did we capture a txId": a
            // withdrawal confirmed against the chain above has no signature to
            // show, and demanding one here would re-send a completed withdrawal.
            if (!decreaseResult) {
              console.log('Trying manual transaction build and send...');

              // Get a FRESH blockhash first
              const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
              console.log(`Fresh blockhash: ${blockhash.slice(0, 20)}...`);

              // Method 1: Use builder to build fresh transactions (preferred)
              const builder = (decreaseLiquidityResult as any).builder;
              if (builder) {
                console.log('Builder available, methods:', Object.keys(builder));
                console.log('Builder prototype:', Object.getOwnPropertyNames(Object.getPrototypeOf(builder || {})));
              }

              // Try different builder methods
              let transactions: any[] = [];

              // Extract instructions from builder and create fresh transaction
              console.log('Extracting instructions from builder...');
              const allInstructions = builder.allInstructions;
              console.log(`Found ${allInstructions.length} instructions`);

              // Check if compute budget instructions already exist
              const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
              const hasComputeBudget = allInstructions.some(
                (ix: TransactionInstruction) => ix.programId.toString() === COMPUTE_BUDGET_PROGRAM_ID
              );
              console.log(`Compute budget already included: ${hasComputeBudget}`);

              if (allInstructions.length > 0) {
                // Get lookup table addresses if available
                const lookupTableAddresses: PublicKey[] = builder.lookupTableAddress || [];
                console.log(`Lookup tables: ${lookupTableAddresses.length}`);

                // Fetch lookup table accounts
                let lookupTableAccounts: AddressLookupTableAccount[] = [];
                if (lookupTableAddresses.length > 0) {
                  console.log('Fetching lookup table accounts...');
                  const lookupTablePromises = lookupTableAddresses.map(async (addr: PublicKey) => {
                    const result = await this.connection.getAddressLookupTable(addr);
                    return result.value;
                  });
                  const results = await Promise.all(lookupTablePromises);
                  lookupTableAccounts = results.filter((a): a is AddressLookupTableAccount => a !== null);
                  console.log(`Loaded ${lookupTableAccounts.length} lookup table account(s)`);
                }

                // Only add priority fee instructions if not already present
                let finalInstructions = [...allInstructions];
                if (!hasComputeBudget) {
                  const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({
                    microLamports: 1000000, // 1 SOL per 1M CU - very high priority
                  });
                  const computeUnitIx = ComputeBudgetProgram.setComputeUnitLimit({
                    units: 600000,
                  });
                  finalInstructions = [computeUnitIx, priorityFeeIx, ...allInstructions];
                }
                console.log(`Building transaction with ${finalInstructions.length} instructions`);

                // Create message with fresh blockhash
                const message = new TransactionMessage({
                  payerKey: this.wallet.publicKey,
                  recentBlockhash: blockhash,
                  instructions: finalInstructions,
                });
                const messageV0 = message.compileToV0Message(lookupTableAccounts);

                // Create versioned transaction
                const versionedTx = new VersionedTransaction(messageV0);
                transactions = [versionedTx];
                console.log('Created fresh transaction with new blockhash');
              } else {
                // Fall back to SDK build methods
                console.log('No instructions found, trying SDK build methods...');

                if (builder?.buildV0) {
                  console.log('Using builder.buildV0...');
                  try {
                    const result = await builder.buildV0({
                      payer: this.wallet.publicKey,
                    });
                    transactions = result.transactions || (result.transaction ? [result.transaction] : []);
                  } catch (buildErr: any) {
                    console.error('buildV0 failed:', buildErr?.message || buildErr);
                  }
                }
              }

              if (transactions.length > 0) {

                console.log(`Built ${transactions.length} fresh transaction(s)`);

                // Get additional signers from SDK result if available
                const sdkSigners = (decreaseLiquidityResult as any).signers || [];
                console.log(`SDK provided ${sdkSigners.length} additional signer(s)`);

                for (let i = 0; i < transactions.length; i++) {
                  const tx = transactions[i];
                  if (!tx) {
                    console.log(`Transaction ${i} is null, skipping`);
                    continue;
                  }

                  console.log(`Processing transaction ${i}:`, typeof tx, tx?.constructor?.name);

                  try {
                    // Check existing signatures
                    if (tx instanceof VersionedTransaction) {
                      const existingSignatures = tx.signatures.filter((sig: Uint8Array) =>
                        !sig.every((byte: number) => byte === 0)
                      ).length;
                      console.log(`Transaction has ${existingSignatures} existing signature(s)`);
                      console.log(`Transaction requires ${tx.message.staticAccountKeys.length} accounts`);
                      console.log(`First few accounts:`, tx.message.staticAccountKeys.slice(0, 3).map((k: PublicKey) => k.toString().slice(0, 20)));

                      // Only sign if not already signed
                      if (existingSignatures === 0) {
                        // Collect all signers: wallet + SDK signers
                        const allSigners = [this.wallet, ...sdkSigners];
                        console.log(`Signing with ${allSigners.length} signer(s)...`);
                        tx.sign(allSigners);
                      } else {
                        console.log('Transaction already signed, using as-is');
                      }
                    } else if (tx.sign) {
                      console.log('Signing legacy transaction...');
                      tx.sign(this.wallet);
                      for (const signer of sdkSigners) {
                        tx.sign(signer);
                      }
                    } else {
                      console.log('Transaction type unknown, attempting raw send...');
                    }

                    // Skip simulation - just send (simulation can timeout and delay us)
                    console.log('Skipping simulation, sending directly...');

                    // Try Jito first for better landing rates
                    let txId: string = '';
                    if (this.useJito && this.jito) {
                      console.log('Sending transaction via Jito...');
                      try {
                        assertSendAllowed('closePosition: Jito send');
                        txId = await this.jito.sendTransaction(tx);
                        console.log(`Jito transaction sent: ${txId}`);
                      } catch (jitoError: any) {
                        console.log(`Jito send failed: ${jitoError?.message}, falling back to regular send`);
                        txId = '';
                      }
                    }

                    // Fall back to regular send if Jito failed or disabled
                    if (!txId) {
                      console.log('Sending transaction via RPC...');
                      assertSendAllowed('closePosition: manual send');
                      txId = await this.connection.sendTransaction(tx, {
                        skipPreflight: true,
                        maxRetries: 3,
                      });
                    }
                    console.log(`Transaction sent: ${txId}`);

                  // Wait for confirmation with proper timeout
                  console.log('Waiting for confirmation...');
                  const startTime = Date.now();
                  const maxWaitTime = 60000; // 60 seconds

                  while (Date.now() - startTime < maxWaitTime) {
                    const status = await this.connection.getSignatureStatus(txId);

                    if (status.value?.confirmationStatus === 'confirmed' ||
                        status.value?.confirmationStatus === 'finalized') {
                      if (status.value.err) {
                        throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.value.err)}`);
                      }
                      decreaseResult = { txId };
                      console.log(`Transaction confirmed: ${txId}`);
                      break;
                    }

                    if (status.value?.err) {
                      throw new Error(`Transaction failed: ${JSON.stringify(status.value.err)}`);
                    }

                    // Check if blockhash expired
                    const blockHeight = await this.connection.getBlockHeight();
                    if (blockHeight > lastValidBlockHeight) {
                      throw new Error('Transaction expired - blockhash no longer valid');
                    }

                    await new Promise(resolve => setTimeout(resolve, 2000));
                  }

                  // Stops at the first confirmation. Safe ONLY because
                  // decreaseResult does not authorise the burn: assertSafeToBurn
                  // below re-reads the position and refuses if anything is left.
                  if (decreaseResult) break;
                  } catch (txError: any) {
                    console.error(`Transaction ${i} failed:`, txError?.message || txError);
                    // Continue to next transaction or retry
                  }
                }
              } else {
                // Method 2: Try to use existing transaction but update blockhash
                console.log('No builder available, trying direct transaction...');
                const existingTx = (decreaseLiquidityResult as any).transaction;

                if (!existingTx) {
                  throw new Error('No transaction or builder available from SDK result');
                }

                // We need to recreate the transaction since we can't update blockhash on existing VersionedTransaction
                console.log('Warning: Using potentially stale transaction, may fail');

                assertSendAllowed('closePosition: existing tx send');
                if (existingTx instanceof VersionedTransaction) {
                  existingTx.sign([this.wallet]);
                }

                const txId = await this.connection.sendTransaction(existingTx, {
                  skipPreflight: true,
                  maxRetries: 3,
                });
                console.log(`Transaction sent: ${txId}`);

                // Quick confirmation check
                await new Promise(resolve => setTimeout(resolve, 5000));
                const status = await this.connection.getSignatureStatus(txId);

                if (status.value?.confirmationStatus === 'confirmed' ||
                    status.value?.confirmationStatus === 'finalized') {
                  if (status.value.err) {
                    throw new Error(`Transaction failed: ${JSON.stringify(status.value.err)}`);
                  }
                  decreaseResult = { txId };
                  console.log(`Transaction confirmed: ${txId}`);
                } else {
                  throw new Error(`Transaction not confirmed: ${JSON.stringify(status.value)}`);
                }
              }
            }
          } catch (execError: any) {
            console.error('decreaseLiquidity full error:', execError);
            console.error('Error name:', execError?.name);
            console.error('Error message:', execError?.message);
            console.error('Error stack:', execError?.stack);
            if (execError?.logs) {
              console.error('Transaction logs:', execError.logs);
            }
            throw new Error(`decreaseLiquidity execution failed: ${execError?.message || String(execError)}`);
          }

          // "Did we get a transaction id" is the wrong question -- a withdrawal
          // confirmed against the chain after its signature was lost has none,
          // and a signature we DID capture proves only that something was sent.
          // The question is whether the position is empty.
          if (!decreaseResult) {
            throw new Error('Decrease liquidity failed - no send succeeded');
          }
          // May be undefined: a withdrawal verified on-chain after its signature
          // was lost has none, and the ledger has to cope with that rather than
          // pretend the decrease did not happen.
          decreaseTxId = decreaseResult.txId ?? decreaseTxId;
          console.log(
            `Liquidity decreased! TX: ${decreaseResult.txId ?? '(signature not captured; verified on-chain)'}`
          );

          // Wait for confirmation
          await new Promise(resolve => setTimeout(resolve, 2000));
        }

        // Close the position NFT
        //
        // LAST RECOVERABLE POINT. The burn destroys the position account, so
        // verify against the chain that it is empty; every send branch above
        // reaches here, and a believed confirmation is not proof.
        assertSafeToBurn(nftMint, await this.readPositionLiquidity(nftMint));

        console.log('Closing position NFT...');
        const closeResult = await this.raydium.clmm.closePosition({
          poolInfo: poolData.poolInfo,
          poolKeys: poolData.poolKeys,
          ownerPosition: position,
          txVersion: TxVersion.V0,
          computeBudgetConfig: {
            units: 600000,
            microLamports: 200000,
          },
        });

        if (!closeResult || !closeResult.execute) {
          throw new Error('closePosition returned invalid result');
        }

        // The NFT burn is a second, independent broadcast -- it reclaims rent and
        // destroys the position account, so it needs its own guard. Reaching here
        // under DRY_RUN is impossible (the decreaseLiquidity branch above refuses
        // first), but a position with zero liquidity skips that branch entirely
        // and lands straight on this send.
        if (config.safety.DRY_RUN) {
          await this.simulateBuiltTransaction(closeResult, 'closePosition: NFT burn');
          throw new SendBlockedError(
            '[GUARD] DRY_RUN: the NFT burn simulated cleanly and was NOT sent. ' +
              'The position NFT still exists. ' +
              'Re-run with ALLOW_REAL_MONEY=true --execute to close it for real.'
          );
        }
        assertSendAllowed('closePosition: NFT burn');

        // `sendAndConfirm: false` ON PURPOSE. The SDK's V0 confirm relies solely
        // on an onSignature WEBSOCKET (no http fallback) and rejects after 60s;
        // with a separately configured wsEndpoint (config.ts) the notification
        // may never arrive, so a landed burn reads as failed. Confirm over http.
        const executeResult = await closeResult.execute({ sendAndConfirm: false });

        if (!executeResult || !executeResult.txId) {
          throw new Error('Execute returned no transaction ID');
        }

        // Record the signature BEFORE confirming, so a later attempt can tell a
        // landed-but-unconfirmed burn from one that never happened.
        burnTxId = executeResult.txId;
        console.log(`NFT burn sent: ${burnTxId}. Confirming...`);

        const burnConfirmation = await this.verifyTransaction(burnTxId, 60000);
        if (!burnConfirmation.success) {
          // Not confirmed is not the same as not landed. The position account is
          // destroyed by a successful burn, so its absence IS the confirmation.
          const stillOnChain = await this.readPositionLiquidity(nftMint);
          if (stillOnChain !== null) {
            throw new Error(
              `NFT burn ${burnTxId} not confirmed and the position is still on-chain: ` +
                `${burnConfirmation.explanation ?? burnConfirmation.error}`
            );
          }
          console.log('Position is gone from chain -- the burn landed.');
        }

        console.log(`Position closed! TX: ${burnTxId}`);
        return { txId: burnTxId, decreaseTxId, withdrewLiquidity };

      } catch (error: any) {
        // A policy refusal is a decision, not a transient failure: never retry
        // it or rewrap it, or callers lose the type that tells "blocked by
        // policy" apart from "failed on chain".
        if (error instanceof SendBlockedError) {
          throw error;
        }

        const errorMsg = error?.message || error?.toString?.() || JSON.stringify(error) || 'Unknown error';
        console.error(`Attempt ${attempt} failed:`, errorMsg);

        if (attempt === maxRetries) {
          throw new Error(`Failed to close position after ${maxRetries} attempts: ${errorMsg}`);
        }

        // Wait before retry
        console.log(`Waiting 3s before retry...`);
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }

    throw new Error('Unexpected error in closePosition');
  }

  /**
   * Swap tokens using Jupiter API (with optional Jito MEV protection)
   *
   * @param valueUsd USD value being moved, checked against MAX_POSITION_USD.
   *   Omitting it leaves the swap UNBOUNDED (the guard skips the ceiling when
   *   undefined). Always pass it from a caller that knows the value.
   */
  private async jupiterSwap(
    inputMint: string,
    outputMint: string,
    amount: number,
    inputDecimals: number,
    valueUsd?: number,
    priceGuard?: SwapPriceGuard
  ): Promise<SwapResult> {
    const amountLamports = Math.floor(amount * Math.pow(10, inputDecimals));

    // Get quote with slippage from config (0.3% = 30 bps)
    const slippageBps = Math.floor(config.strategy.MAX_SLIPPAGE * 10000); // Convert to basis points
    const outputDecimals = outputMint === TOKENS.SOL.toString() ? 9 : 6;
    const direction: 'SOL_TO_USDC' | 'USDC_TO_SOL' =
      outputMint === TOKENS.SOL.toString() ? 'USDC_TO_SOL' : 'SOL_TO_USDC';

    /**
     * Quote the route and decide whether its PRICE is acceptable.
     *
     * One function so every quote (including rebuilds) is judged identically.
     * `slippageBps` does not bound price -- it measures the fill against THIS
     * quote, so a route far below market can fill perfectly. The reference
     * price comes from the caller, which already read the pool.
     */
    const quoteAndGuard = async (attempt: number): Promise<any> => {
      const quoteResponse = await fetch(
        `${JUPITER_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${slippageBps}`
      );
      const quote = await quoteResponse.json() as any;

      if (quote.error) {
        throw new Error(`Quote error: ${quote.error}`);
      }

      const label = attempt === 0 ? 'Quote' : `Quote (refreshed #${attempt})`;
      console.log(`${label}: ${amount} -> ${(quote.outAmount / Math.pow(10, outputDecimals)).toFixed(4)}`);
      console.log(`Price impact: ${quote.priceImpactPct || '0'}%`);

      const verdict = checkQuotePrice({
        impliedPrice: impliedPriceFromQuote(quote.inAmount, quote.outAmount, direction) ?? NaN,
        referencePrice: priceGuard?.referencePrice ?? null,
        poolFeeRate: priceGuard?.poolFeeRate ?? 0,
        slippageRate: config.strategy.MAX_SLIPPAGE,
        maxImpactRate: config.strategy.MAX_PRICE_IMPACT,
        direction,
      });

      if (!verdict.acceptable) {
        // A SendBlockedError, not a generic one: this is a policy refusal before
        // anything moved, and the retry ladders in this repo already know not to
        // retry those.
        throw new SendBlockedError(`[PRICE] Refusing the swap -- ${verdict.reason}`);
      }

      console.log(
        `[PRICE] Quote is ${(verdict.deviation * 100).toFixed(3)}% vs reference ` +
          `(band ${(verdict.allowed * 100).toFixed(3)}%)`
      );

      return quote;
    };

    let quote = await quoteAndGuard(0);
    let builds = 0;

    /**
     * Build the swap transaction. CALLABLE MORE THAN ONCE, and that is the point.
     *
     * Jupiter mints the blockhash inside this response, so re-POSTing gives a
     * retry a live deadline; re-sending one frozen transaction cannot land.
     *
     * EVERY REBUILD RE-QUOTES and re-runs the same price guard. A stale quote's
     * minimum-out is fixed at quote time, so once price drifts past
     * MAX_SLIPPAGE every bundle built from it is silently dropped. This is the
     * SAME guard with the same thresholds, never a widened one; the reference
     * price does not age, so a long trend eventually refuses (the safe way).
     */
    const buildSwapTx = async (): Promise<VersionedTransaction> => {
      if (builds > 0) {
        quote = await quoteAndGuard(builds);
      }
      builds += 1;

      const swapResponse = await fetch(`${JUPITER_API}/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: this.wallet.publicKey.toString(),
          wrapAndUnwrapSol: true,
          // Matches the open's priority fee. Jito inclusion is ordered by tip,
          // but this is what the RPC fallback is priced at.
          computeUnitPriceMicroLamports: 500000,
        }),
      });
      const swapData = await swapResponse.json() as any;

      if (swapData.error) {
        throw new Error(`Swap error: ${swapData.error}`);
      }

      return VersionedTransaction.deserialize(
        Buffer.from(swapData.swapTransaction, 'base64')
      );
    };

    const transaction = await buildSwapTx();

    let txId: string;

    if (this.useJito) {
      // Use Jito for MEV protection (fast, private)
      console.log('[Swap] Using Jito MEV protection...');
      assertSendAllowed('jupiterSwap: Jito send', valueUsd);
      txId = await this.jito.sendTransaction(transaction, valueUsd, buildSwapTx);
    } else {
      // Normal transaction
      assertSendAllowed('jupiterSwap: plain RPC send', valueUsd);
      transaction.sign([this.wallet]);
      txId = await this.connection.sendTransaction(transaction, {
        skipPreflight: true,
        maxRetries: 3,
      });
      await this.connection.confirmTransaction(txId, 'confirmed');
    }

    console.log(`Swap complete! TX: ${txId}`);

    // The quote goes back with the signature: per-hop DEX fees, Jupiter's
    // platform fee and the quoted output live only here, and `outAmount` is the
    // ONLY baseline for execution slippage. Do not drop it.
    return { txId, quote: quote as SwapQuote };
  }

  /**
   * Swap SOL to USDC
   */
  async swapSolToUsdc(
    solAmount: number,
    valueUsd?: number,
    priceGuard?: SwapPriceGuard
  ): Promise<SwapResult> {
    console.log(`Swapping ${solAmount.toFixed(4)} SOL to USDC`);

    const inputMint = TOKENS.SOL.toString();
    const outputMint = config.network.IS_DEVNET ? TOKENS.USDC_DEV.toString() : TOKENS.USDC.toString();

    // Callers know the SOL price; without valueUsd the swap is not capped.
    return this.jupiterSwap(inputMint, outputMint, solAmount, 9, valueUsd, priceGuard);
  }

  /**
   * Swap USDC to SOL
   */
  async swapUsdcToSol(
    usdcAmount: number,
    valueUsd?: number,
    priceGuard?: SwapPriceGuard
  ): Promise<SwapResult> {
    console.log(`Swapping ${usdcAmount.toFixed(2)} USDC to SOL`);

    const inputMint = config.network.IS_DEVNET ? TOKENS.USDC_DEV.toString() : TOKENS.USDC.toString();
    const outputMint = TOKENS.SOL.toString();

    // USDC is the unit of account, so the amount IS the USD value unless a
    // caller has a better figure.
    return this.jupiterSwap(inputMint, outputMint, usdcAmount, 6, valueUsd ?? usdcAmount, priceGuard);
  }
}

export default RaydiumClient;
