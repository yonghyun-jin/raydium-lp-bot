// Jito Bundle Service for MEV Protection

import {
  Connection,
  Keypair,
  VersionedTransaction,
  TransactionMessage,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { assertSendAllowed } from './guard';
import { JITO } from './config';
import {
  tipForRung,
  nextStart,
  DEFAULT_LADDER,
  TipLadderConfig,
} from './tipLadder';

// Jito Block Engine endpoints
export const JITO_ENDPOINTS = {
  mainnet: [
    'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
    'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles',
    'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles',
    'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles',
    'https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles',
  ],
};

// Jito tip accounts (validators receive tips here)
/**
 * Jito's tip accounts. A bundle must write-lock ONE of these to enter the auction.
 *
 * AUTHORITATIVE SOURCE: the block engine's own `getTipAccounts` RPC method.
 * Re-verify against it rather than against memory or a doc page -- these are
 * 44-character base58 strings and the failure mode below is invisible to review.
 *
 * ONE ENTRY WAS CORRUPTED FOR WEEKS and cost roughly one rung in eight.
 * `HFqU5x63VTqvQss8hp11i4` + `bVpkNgmnfxWYYMHpMYEJdV` instead of
 * `...i4` + `wVV8bD44PvwucfZ2bU7gRe`: the first 22 characters match, both
 * strings are valid base58 so `new PublicKey` never threw, and the address
 * simply does not exist on chain. `pickTipAccount` draws at RANDOM, so 1 in 8
 * rungs was rejected with "Bundles must write lock at least one tip account to
 * be eligible for the auction" while its siblings went out to 5/5 regions --
 * an intermittent, tip-size-independent failure that burned blockhash window
 * time and looked exactly like losing the auction.
 *
 * `client.ts` consumes this same list as the tip-vs-rent discriminator for
 * P&L, so a wrong entry is a cost-attribution bug as well as a send bug.
 */
export const JITO_TIP_ACCOUNTS = [
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
];

/**
 * Jito's own published distribution of tips that actually got included.
 *
 * VALUES COME BACK IN SOL, not lamports -- `0.00039`, not `389930`. Reading
 * them as lamports is a 1e9 error in the direction of tipping nothing.
 */
export const JITO_TIP_FLOOR_URL = 'https://bundles.jito.wtf/api/v1/bundles/tip_floor';

/** Pull the 95th percentile of landed tips, in SOL, out of a tip_floor body. */
export function parseTipFloorSol(payload: unknown): number | null {
  const row = Array.isArray(payload) ? payload[0] : payload;
  const value = (row as any)?.landed_tips_95th_percentile;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

/**
 * Choose the tip, in SOL, from a market reading and the configured bounds.
 *
 * The 95th percentile rather than the 50th, and the reason is the whole bug
 * this function exists to fix: the old hardcoded 10,000 lamports sat EXACTLY on
 * the median of landed tips, so roughly half the market outbid every bundle
 * this bot sent. At current levels the 95th percentile is about five cents --
 * against a four-figure rebalance, the tip is not the cost worth optimising.
 *
 * An inverted configuration (floor above ceiling) resolves to the ceiling
 * rather than throwing: a tip that is merely capped still lands sometimes, and
 * refusing to send at all strands funds mid-rebalance, which is the failure
 * this is here to prevent.
 */
export function clampTipSol(
  marketSol: number | null,
  floorSol: number,
  maxSol: number
): number {
  const ceiling = Math.max(floorSol, maxSol);
  if (marketSol === null || !Number.isFinite(marketSol) || marketSol <= 0) {
    return Math.min(floorSol, ceiling);
  }
  return Math.min(Math.max(marketSol, floorSol), ceiling);
}

/** A copy, shuffled. Sampling WITHOUT replacement, unlike getRandomEndpoint. */
export function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const TIP_FLOOR_TTL_MS = 30_000;
let tipFloorCache: { sol: number; at: number } | null = null;

/**
 * The market tip, or null if it cannot be read.
 *
 * Never throws and never blocks a send for long: a tip we cannot price falls
 * back to the configured floor, which is strictly better than not sending.
 */
async function fetchMarketTipSol(): Promise<number | null> {
  if (tipFloorCache && Date.now() - tipFloorCache.at < TIP_FLOOR_TTL_MS) {
    return tipFloorCache.sol;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    let sol: number | null;
    try {
      const response = await fetch(JITO_TIP_FLOOR_URL, { signal: controller.signal });
      sol = parseTipFloorSol(await response.json());
    } finally {
      clearTimeout(timer);
    }
    if (sol === null) return null;
    tipFloorCache = { sol, at: Date.now() };
    return sol;
  } catch {
    return null;
  }
}

/**
 * Encode a bundle for the Jito block engine.
 *
 * Jito's sendBundle expects **base58**. Sending base64 produces
 * "transaction could not be decoded", a bug fixed three times in this repo
 * (f1dea64, f9205b8, 675ba29) and never covered by a test until now.
 *
 * Order matters too: the tip transaction must be last.
 */
export function encodeBundle(
  mainTx: VersionedTransaction,
  tipTx: VersionedTransaction
): [string, string] {
  return [bs58.encode(mainTx.serialize()), bs58.encode(tipTx.serialize())];
}

/**
 * Where the ladder's learned starting tip lives.
 *
 * An INTERFACE because the useful implementation is durable -- convergence on
 * the smallest viable tip only compounds if it survives a redeploy, and Railway
 * redeploys often -- but jito.ts must not reach into the recording layer to get
 * it. The in-memory default below is correct, just forgetful: it converges within
 * one process and falls back to the configured floor after a restart, which is
 * safe because the floor already bids above the typical 95th percentile.
 */
export interface TipMemory {
  /** The remembered starting tip in lamports, or null for a cold start. */
  startLamports(): Promise<number | null>;
  /** Report what the ladder learned. Must never throw. */
  record(outcome: {
    winningLamports?: number;
    highestTriedLamports?: number;
  }): Promise<void>;
}

/** Process-local tip memory. Converges within a run; forgets on restart. */
export class InMemoryTipMemory implements TipMemory {
  private current: number | null = null;

  async startLamports(): Promise<number | null> {
    return this.current;
  }

  async record(outcome: {
    winningLamports?: number;
    highestTriedLamports?: number;
  }): Promise<void> {
    this.current = nextStart({
      floorLamports: Math.max(1, Math.floor(JITO.TIP_SOL_FLOOR * 1e9)),
      ceilingLamports: Math.max(1, Math.floor(JITO.TIP_SOL_MAX * 1e9)),
      winningLamports: outcome.winningLamports,
      highestTriedLamports: outcome.highestTriedLamports ?? this.current ?? undefined,
    });
  }
}

export interface JitoConfig {
  /**
   * A fixed tip in lamports, bypassing the ladder and the market entirely.
   *
   * There is deliberately NO DEFAULT. This used to be `tipLamports: 10000`, a
   * source literal that was the 50th percentile of Jito's landed tips and the
   * direct cause of a rebalance that closed a position and could not reopen it.
   */
  tipLamportsOverride?: number;
  /** Multiplier between rungs. Small on purpose -- see ./tipLadder. */
  stepFactor: number;
  /** Cap on rungs per blockhash window; the window's own life is the real cap. */
  maxRungs: number;
  /**
   * How long ONE rung waits for its bundle, in ms.
   *
   * SHORT, because a bundle either wins its slot auction within a few slots or it
   * does not -- a slot is ~400ms and Jito auctions per slot, so waiting longer
   * only burns window. This was 15000 (and before that 60000, which spent a
   * blockhash's entire lifetime on one attempt and killed a real $1000 open).
   * At 5s a ~60s window fits ~10 rungs instead of 3, which is what makes a
   * fine-grained climb affordable at all.
   */
  rungTimeoutMs: number;
  /** Wall-clock ceiling for the whole send, across every window. */
  totalBudgetMs: number;
  /** How many fresh-blockhash windows to climb through before giving up. */
  maxWindows: number;
}

const DEFAULT_CONFIG: JitoConfig = {
  stepFactor: DEFAULT_LADDER.stepFactor,
  maxRungs: 12,
  rungTimeoutMs: 5000,
  /**
   * From JITO_TOTAL_BUDGET_MS, default 240s.
   *
   * It was a hard 90s, and the reasoning was the QUOTE rather than the
   * blockhash: a Jupiter quote carries a minimum-out fixed at quote time, and a
   * stale one eventually trips the on-chain check (6017) or is dropped in
   * simulation. That held while a rebuild reused the first quote. Each window
   * now RE-QUOTES and re-runs the price guard, so time spent buys fresh
   * attempts, and the ceiling belongs in config where an incident can move it.
   */
  get totalBudgetMs(): number {
    return JITO.TOTAL_BUDGET_MS;
  },
  get maxWindows(): number {
    return JITO.MAX_WINDOWS;
  },
};

/**
 * The transaction expired before anything could include it.
 *
 * A distinct type because it is the one send failure that is KNOWN not to have
 * moved money -- an expired transaction cannot be included by anyone. Callers
 * can say so plainly instead of the honest-but-alarming "unknown if it
 * succeeded" that a timeout deserves.
 */
/**
 * The transaction landed and the program rejected it.
 *
 * Distinct from a timeout for the same reason BlockhashExpiredError is: this
 * one is KNOWN to have changed nothing except the fee, so a caller can say so
 * rather than leaving the operator to wonder.
 */
export class TransactionRevertedError extends Error {
  readonly txId: string;
  constructor(message: string, txId: string) {
    super(message);
    this.name = 'TransactionRevertedError';
    this.txId = txId;
  }
}

/**
 * Turn a confirmation result into a decision, or throw.
 *
 * A FREE FUNCTION so it can be driven directly in a test. `sendNormalTransaction`
 * cannot be: `assertSendAllowed` refuses any send from a test process, which is
 * correct and must not be mocked away. An earlier version of this check was
 * guarded only by matching the source text `confirmation.value?.err`, and
 * reintroducing the bug as `if (false && confirmation.value?.err)` left that
 * text in place -- a guard that could not fail.
 *
 * CONFIRMED IS NOT SUCCEEDED. `connection.confirmTransaction` resolves for a
 * transaction that LANDED AND REVERTED; the failure arrives as `value.err`.
 * The case that matters most is the one the send path exists to protect:
 * Jupiter's on-chain minimum-out check firing because the price moved. That is
 * the slippage guard WORKING, and it was being reported as a successful swap.
 */
export function assertConfirmationSucceeded(
  txId: string,
  confirmation: { value?: { err?: unknown } | null } | null | undefined
): void {
  const err = confirmation?.value?.err;
  if (err === null || err === undefined) return;

  throw new TransactionRevertedError(
    `Transaction ${txId} landed and FAILED on-chain: ${JSON.stringify(err)}. Nothing moved.`,
    txId
  );
}

/**
 * Refuse a transaction whose fee-payer signature is still the default.
 *
 * `VersionedTransaction` is born with its signature slots zero-filled, and
 * `sendTransaction` will happily send that: the RPC accepts the bytes, hands
 * back base58 of 64 zero bytes -- `1111...1111` -- and nothing can ever confirm
 * it. The operator sees "Transaction was not confirmed in 30.00 seconds. It is
 * unknown if it succeeded or failed", which is the WORST available answer,
 * because the truth is that it provably could not have succeeded.
 *
 * Shipped exactly this way on 2026-10-13: the new RPC fallback returned from
 * the window loop BEFORE the `transaction.sign(...)` line inside it, so the
 * rebuilt transaction was never signed. A FREE FUNCTION so a test can drive it
 * without a wallet or a network.
 */
export function assertSigned(transaction: VersionedTransaction): void {
  const signature = transaction.signatures[0];
  if (!signature || signature.every(byte => byte === 0)) {
    throw new Error(
      'Refusing to send an UNSIGNED transaction: the fee-payer signature is still ' +
        'the default, so this could only produce a signature that never confirms. ' +
        'Nothing was sent and no money moved.'
    );
  }
}

export class BlockhashExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockhashExpiredError';
  }
}

/**
 * Jito, the RPC and web3.js all word this differently; all three mean the same
 * thing.
 *
 * `block height exceeded` is web3.js's own TransactionExpiredBlockheightExceeded
 * Error, whose message is `Signature ... has expired: block height exceeded.`
 * -- it contains NEITHER of the other two phrases, so it used to fall through
 * to the "unknown if it succeeded" branch and send the operator looking for
 * money that could not have moved.
 */
function isExpiredBlockhash(error: unknown): boolean {
  if ((error as any)?.name === 'TransactionExpiredBlockheightExceededError') return true;
  const message = String((error as any)?.message ?? error).toLowerCase();
  return (
    message.includes('expired blockhash') ||
    message.includes('blockhash not found') ||
    message.includes('block height exceeded')
  );
}

export class JitoService {
  private connection: Connection;
  private wallet: Keypair;
  private config: JitoConfig;
  private tips: TipMemory;

  constructor(
    connection: Connection,
    wallet: Keypair,
    config?: Partial<JitoConfig>,
    tips?: TipMemory
  ) {
    this.connection = connection;
    this.wallet = wallet;
    this.config = { ...DEFAULT_CONFIG, ...config };
    // Shared across sends from this client, which is what lets the ladder learn.
    this.tips = tips ?? new InMemoryTipMemory();
  }

  /**
   * Get a random Jito tip account
   */
  private getRandomTipAccount(): PublicKey {
    const index = Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
    return new PublicKey(JITO_TIP_ACCOUNTS[index]);
  }

  /**
   * Get a random Jito endpoint
   */
  private getRandomEndpoint(): string {
    const index = Math.floor(Math.random() * JITO_ENDPOINTS.mainnet.length);
    return JITO_ENDPOINTS.mainnet[index];
  }

  /**
   * Create a tip transaction for Jito validators
   */
  private async createTipTransaction(tipLamports: number): Promise<VersionedTransaction> {
    const tipAccount = this.getRandomTipAccount();
    const { blockhash } = await this.connection.getLatestBlockhash();

    const tipInstruction = SystemProgram.transfer({
      fromPubkey: this.wallet.publicKey,
      toPubkey: tipAccount,
      lamports: tipLamports,
    });

    const message = new TransactionMessage({
      payerKey: this.wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: [tipInstruction],
    }).compileToV0Message();

    const tipTx = new VersionedTransaction(message);
    tipTx.sign([this.wallet]);

    return tipTx;
  }

  /**
   * Send transaction via Jito bundle (MEV protected)
   */

  /** Where this ladder should start, in lamports. */
  private async resolveStartLamports(floor: number, ceiling: number): Promise<number> {
    if (this.config.tipLamportsOverride !== undefined) {
      return this.config.tipLamportsOverride;
    }

    // Remembered first: the whole point of the ladder is to converge on the
    // smallest tip that lands, and that only happens if each send starts from
    // what the last one learned instead of re-deriving a percentile.
    const remembered = await this.tips.startLamports();
    if (remembered !== null && remembered > 0) {
      return Math.max(floor, Math.min(Math.floor(remembered), ceiling));
    }

    // Cold start. The floor (JITO_TIP_SOL, 0.0001 SOL = 100_000 lamports) is
    // already an order of magnitude above the median and usually above the 95th
    // percentile too, so a bot with no history bids from ABOVE and the learning
    // walks it down -- never blind from zero.
    const marketSol = await fetchMarketTipSol();
    const tipSol = clampTipSol(marketSol, JITO.TIP_SOL_FLOOR, JITO.TIP_SOL_MAX);
    return Math.floor(tipSol * LAMPORTS_PER_SOL);
  }

  /**
   * Send a transaction as a Jito bundle, climbing a tip ladder.
   *
   * THE SAFETY PROPERTY, and the reason this is shaped the way it is:
   *
   *   WITHIN one blockhash window the MAIN TRANSACTION IS BYTE-IDENTICAL across
   *   every rung. Only the tip transaction differs. Solana rejects a duplicate
   *   signature, so however many rungs are in flight, AT MOST ONE CAN EXECUTE --
   *   and whichever lands pays whichever tip it happened to carry. That makes
   *   climbing free of double-spend risk.
   *
   *   ACROSS windows the main transaction is REBUILT, which gives it a new
   *   blockhash and therefore a NEW SIGNATURE. Two different signatures doing
   *   the same swap CAN both execute. So a rebuild is only allowed once the old
   *   bytes are PROVABLY DEAD -- either Jito said `expired blockhash` (its own
   *   proof) or `isBlockhashValid` returned an explicit false. Anything we cannot
   *   prove, including an RPC 429, counts as STILL ALIVE and stops the climb.
   *   Without that gate, rebuilding to escape the deadline trades "cannot land"
   *   for "might land twice".
   *
   * Rungs are free: a bundle that is not selected executes nothing, so it costs
   * neither tip nor network fee. The budget being spent is TIME.
   */
  async sendTransaction(
    transaction: VersionedTransaction,
    valueUsd?: number,
    rebuild?: () => Promise<VersionedTransaction>
  ): Promise<string> {
    // valueUsd is what MAX_POSITION_USD is checked against. It was not being
    // passed, so the Jito path -- the DEFAULT path, USE_JITO defaults true --
    // bypassed the size ceiling entirely while the plain-RPC path honoured it.
    assertSendAllowed('Jito bundle send', valueUsd);

    const floor = Math.max(1, Math.floor(JITO.TIP_SOL_FLOOR * LAMPORTS_PER_SOL));
    const ceiling = Math.max(floor, Math.floor(JITO.TIP_SOL_MAX * LAMPORTS_PER_SOL));
    const deadline = Date.now() + this.config.totalBudgetMs;

    let start = await this.resolveStartLamports(floor, ceiling);
    let highestTried = 0;

    for (let window = 0; window < this.config.maxWindows; window++) {
      if (Date.now() >= deadline) break;

      // GIVE UP ON THE AUCTION WHILE THE TRANSACTION IS STILL ALIVE.
      //
      // Reached only from window 2 onward, where `transaction` has just been
      // rebuilt and therefore carries a fresh blockhash and a fresh quote. The
      // old shape could only reach the RPC fallback after the entire budget was
      // spent, when the bytes were already dead and it had no honest choice but
      // to refuse -- so the path that does not need to win an auction was the
      // one path never taken, and the money stayed in the wallet.
      //
      // Same signed bytes as any bundle still pending, and a duplicate
      // signature cannot execute twice.
      // Through `guardedRpcFallback`, never straight to `sendNormalTransaction`:
      // "just rebuilt" is a good reason to BELIEVE the blockhash is alive, and
      // believing is not checking. The gate verifies it, carries `valueUsd` so
      // MAX_POSITION_USD still applies, and refuses out loud if the rebuild
      // somehow handed back something dead.
      if (window >= JITO.RPC_FALLBACK_AFTER_WINDOWS) {
        await this.tips.record({ highestTriedLamports: highestTried });
        return await this.guardedRpcFallback(
          transaction,
          valueUsd,
          `${window} Jito window(s) did not land (highest tip tried: ${highestTried} lamports)`
        );
      }

      // Signed and encoded ONCE per window. Every rung below reuses these exact
      // bytes; that identity is the no-double-spend guarantee.
      try {
        transaction.sign([this.wallet]);
      } catch (e) {
        // Already signed, continue
      }
      const mainB58 = bs58.encode(transaction.serialize());

      const ladder: TipLadderConfig = {
        startLamports: start,
        ceilingLamports: ceiling,
        stepFactor: this.config.stepFactor,
        maxRungs: this.config.maxRungs,
      };
      console.log(
        `[Jito] Window ${window + 1}/${this.config.maxWindows}: climbing from ` +
          `${start} lamports, ceiling ${ceiling}, up to ${this.config.maxRungs} rungs`
      );

      let expiredDuringWindow = false;

      for (let rung = 0; rung < this.config.maxRungs; rung++) {
        if (Date.now() >= deadline) break;

        const tipLamports = tipForRung(ladder, rung);
        highestTried = Math.max(highestTried, tipLamports);

        let outcome: { txId?: string; expired?: boolean };
        try {
          outcome = await this.attemptRung(mainB58, tipLamports, rung);
        } catch (e: any) {
          console.log(`[Jito] Rung ${rung + 1} could not be built: ${e.message}`);
          break;
        }

        if (outcome.txId) {
          console.log(`[Jito] Landed at ${tipLamports} lamports (rung ${rung + 1}).`);
          await this.tips.record({ winningLamports: tipLamports });
          return outcome.txId;
        }

        if (outcome.expired) {
          // Jito's own proof that these bytes are dead. No waiting needed.
          console.log('[Jito] Window expired -- these bytes can no longer land.');
          expiredDuringWindow = true;
          break;
        }
      }

      if (!rebuild) {
        // Nothing can change the bytes, so a further window is the same bet.
        break;
      }
      if (window === this.config.maxWindows - 1 || Date.now() >= deadline) break;

      // THE GATE. Rebuild only against bytes we can prove are dead.
      const dead = expiredDuringWindow || (await this.provablyDead(transaction));
      if (!dead) {
        console.log(
          '[Jito] Cannot PROVE the previous transaction is dead, so it will not be ' +
            'rebuilt -- a second signature could double-execute. Stopping the climb.'
        );
        break;
      }

      try {
        transaction = await rebuild();
      } catch (e: any) {
        console.log(`[Jito] Rebuild failed: ${e.message}. Stopping the climb.`);
        break;
      }
      // Resume where the climb stopped rather than re-walking it.
      start = Math.max(start, highestTried);
    }

    await this.tips.record({ highestTriedLamports: highestTried });

    return this.guardedRpcFallback(
      transaction,
      valueUsd,
      `Jito could not land it within ${this.config.totalBudgetMs}ms ` +
        `(highest tip tried: ${highestTried} lamports)`
    );
  }

  /**
   * One rung: submit the bundle to EVERY region at once, then wait.
   *
   * Parallel rather than one region per attempt. Regions are free to add -- an
   * unselected bundle costs nothing -- and the bundle id is a hash of its
   * contents, so all regions return the SAME id and one status poll covers them
   * all. It also removes a real source of noise: the old code picked one region
   * at random WITH replacement and on a live ladder drew tokyo, tokyo, mainnet,
   * so a lost auction could just mean the wrong block engine. More coverage per
   * tip means a LOWER winning tip.
   */
  private async attemptRung(
    mainB58: string,
    tipLamports: number,
    rung: number
  ): Promise<{ txId?: string; expired?: boolean }> {
    const tipTx = await this.createTipTransaction(tipLamports);
    const tipB58 = bs58.encode(tipTx.serialize());

    const submissions = await Promise.allSettled(
      JITO_ENDPOINTS.mainnet.map(endpoint => this.submitBundle(endpoint, mainB58, tipB58))
    );

    const accepted = submissions.find(
      (s): s is PromiseFulfilledResult<string> => s.status === 'fulfilled'
    );
    const errors = submissions
      .filter((s): s is PromiseRejectedResult => s.status === 'rejected')
      .map(s => String(s.reason?.message ?? s.reason));

    if (!accepted) {
      // Every region refused. If they refused because the blockhash is gone,
      // that is proof of death and the caller may rebuild.
      const expired = errors.some(e => isExpiredBlockhash(e));
      console.log(
        `[Jito] Rung ${rung + 1} (${tipLamports} lamports) rejected everywhere: ${errors[0]}`
      );
      return { expired };
    }

    console.log(
      `[Jito] Rung ${rung + 1}: ${tipLamports} lamport tip, bundle ${accepted.value} ` +
        `to ${submissions.filter(s => s.status === 'fulfilled').length}/` +
        `${JITO_ENDPOINTS.mainnet.length} regions`
    );

    const txId = await this.pollBundle(accepted.value);
    return txId ? { txId } : {};
  }

  /** POST one bundle to one block engine. Resolves with the bundle id. */
  private async submitBundle(
    endpoint: string,
    mainB58: string,
    tipB58: string
  ): Promise<string> {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendBundle',
        // Bundle: main tx first, then tip tx (tip must be last)
        params: [[mainB58, tipB58]],
      }),
    });

    // READ THE STATUS. This used to go straight to `response.json()`, so a 429
    // or a 5xx surfaced as whatever the JSON parser said about an HTML body --
    // which is how "rejected everywhere: Unexpected token '<'" could stand in
    // for "Jito is rate-limiting this IP". Five regions get the same bundle
    // every rung, and some of them really do answer 429: the logs for
    // 2026-10-13 show rungs reaching only 2/5 and 4/5 regions with no reason
    // recorded anywhere.
    const body = await response.text();

    if (!response.ok) {
      const host = (() => {
        try {
          return new URL(endpoint).hostname;
        } catch {
          return endpoint;
        }
      })();
      throw new Error(
        `Jito ${host} HTTP ${response.status}` + (body ? `: ${body.slice(0, 200)}` : '')
      );
    }

    let result: any;
    try {
      result = JSON.parse(body);
    } catch {
      throw new Error(`Jito returned a non-JSON body: ${body.slice(0, 200)}`);
    }

    if (result.error) {
      throw new Error(result.error.message || 'Jito bundle error');
    }
    return result.result;
  }

  /**
   * Are these bytes PROVABLY unable to land?
   *
   * True only on an explicit `false` from the chain. An unreadable answer -- an
   * RPC 429, which this project's RPC really does return in bursts -- is NOT
   * proof, and answering "dead" on a throttle would let a rebuild produce a
   * second live signature for the same swap. Fails closed in the direction that
   * costs a missed retry rather than a double-spend.
   */
  private async provablyDead(transaction: VersionedTransaction): Promise<boolean> {
    try {
      const blockhash = transaction.message.recentBlockhash;
      if (!blockhash) return false;
      const res = await this.connection.isBlockhashValid(blockhash, {
        commitment: 'confirmed',
      });
      const valid = typeof res === 'boolean' ? res : res.value;
      return valid === false;
    } catch {
      return false;
    }
  }

  /**
   * Plain RPC, but ONLY if the transaction could still land.
   *
   * Sending an expired transaction produces a SIGNATURE, and a signature is what
   * makes a failure read as "unknown if it succeeded" when in fact nothing could
   * have happened. A real $1000 open died exactly that way and the operator went
   * looking for money that had never moved.
   *
   * THE ONLY PATH from sendTransaction to sendNormalTransaction, so the check
   * cannot be skipped by adding another fallback branch above it.
   */
  private async guardedRpcFallback(
    transaction: VersionedTransaction,
    valueUsd: number | undefined,
    reason: string
  ): Promise<string> {
    const stillValid = await this.blockhashStillValid(transaction);
    if (!stillValid) {
      throw new BlockhashExpiredError(
        'Jito could not land the bundle and the transaction has now expired, so the ' +
          'RPC fallback was NOT attempted -- it would have produced a signature that ' +
          'can never confirm. Nothing was sent that could land, and no money moved.'
      );
    }

    console.log(`[Jito] ${reason}, falling back to normal tx...`);
    return this.sendNormalTransaction(transaction, valueUsd);
  }

  /**
   * Is this transaction's blockhash still usable?
   *
   * Asked before the RPC fallback so a doomed send is refused rather than
   * turned into a signature nobody can interpret. An unreadable answer is
   * treated as STILL VALID: refusing a send that might have worked is the
   * worse error here, and the caller's own confirmation still gates success.
   */
  private async blockhashStillValid(transaction: VersionedTransaction): Promise<boolean> {
    try {
      const blockhash = transaction.message.recentBlockhash;
      if (!blockhash) return true;
      const res = await this.connection.isBlockhashValid(blockhash, { commitment: 'confirmed' });
      return typeof res === 'boolean' ? res : res.value;
    } catch {
      return true;
    }
  }

  /**
   * Wait for one rung's bundle. Returns the signature, or null if it did not land.
   *
   * Returns rather than throws: not landing is the EXPECTED outcome of most rungs
   * and costs nothing, so it is ordinary control flow, not an error. The old
   * version threw `Bundle confirmation timeout`, which made every unselected
   * bundle look like a failure worth logging as one.
   */
  private async pollBundle(bundleId: string): Promise<string | null> {
    const startTime = Date.now();
    /**
     * The last thing Jito said about this bundle, for the log on the way out.
     *
     * A rung that does not land used to return `null` in total silence, so the
     * only account of 30 unlanded bundles was the absence of a success line.
     * Jito distinguishes a bundle it never accepted from one it dropped in
     * simulation from one still pending, and which of those it was decides
     * whether the next move is a bigger tip, a fresher quote, or a different
     * send path entirely.
     */
    let lastSeen = 'no status returned';

    while (Date.now() - startTime < this.config.rungTimeoutMs) {
      await new Promise(resolve => setTimeout(resolve, 1000));

      try {
        const endpoint = this.getRandomEndpoint().replace('/bundles', '/getBundleStatuses');
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getBundleStatuses',
            params: [[bundleId]],
          }),
        });

        const result = await response.json() as any;

        if (result.result?.value?.[0]) {
          const status = result.result.value[0];
          lastSeen =
            `confirmation_status=${status.confirmation_status ?? 'null'}` +
            (status.err ? ` err=${JSON.stringify(status.err).slice(0, 120)}` : '');
          if (status.confirmation_status === 'confirmed' || status.confirmation_status === 'finalized') {
            return status.transactions?.[0] || bundleId;
          }
        } else if (result.error) {
          lastSeen = `getBundleStatuses error: ${result.error.message ?? JSON.stringify(result.error)}`;
        } else {
          // An accepted bundle id that the status API does not know is the
          // signature of one that never entered the auction.
          lastSeen = 'not known to getBundleStatuses';
        }
      } catch (e: any) {
        lastSeen = `status unreadable: ${e?.message ?? e}`;
      }
    }

    console.log(`[Jito] Bundle ${bundleId.slice(0, 8)} did not land (${lastSeen}).`);
    return null;
  }

  /**
   * Fallback: Send via normal RPC with timeout handling
   */
  private async sendNormalTransaction(
    transaction: VersionedTransaction,
    valueUsd?: number
  ): Promise<string> {
    assertSendAllowed('Jito fallback: plain RPC send', valueUsd);

    // SIGN HERE, where the send is, and prove it took.
    //
    // The bundle path signs inside its window loop, so every transaction that
    // arrives from a REBUILD has never been signed -- and the fallback is now
    // reached on exactly those. Signing is idempotent, so doing it at the one
    // choke point is cheaper than reasoning about which caller already did.
    // `assertSigned` then turns "unsigned" from a 30-second mystery into an
    // immediate refusal that names itself.
    transaction.sign([this.wallet]);
    assertSigned(transaction);

    const txId = await this.connection.sendTransaction(transaction, {
      skipPreflight: true,
      maxRetries: 3,
    });

    console.log(`[Tx] Sent: ${txId}`);

    try {
      // CONFIRMED IS NOT SUCCEEDED. `confirmTransaction` resolves for a
      // transaction that LANDED AND REVERTED -- the failure arrives as
      // `value.err`, not as a throw -- so returning here without reading it
      // reports a reverted swap as a completed one.
      //
      // The case that matters most is the one this whole path exists to
      // protect: Jupiter's on-chain minimum-out check firing because the price
      // moved. That is the slippage guard WORKING, and it was being reported
      // as a successful swap. The wallet is unchanged, so the caller then
      // computes `actualOut` from balance deltas and gets ~0.
      //
      // The timeout branch below already reads `value.err` (and
      // `verifyTransaction` does the same for creates, client.ts). This is the
      // happy path catching up with them.
      const confirmation = await this.connection.confirmTransaction(txId, 'confirmed');
      assertConfirmationSucceeded(txId, confirmation);

      console.log(`[Tx] Confirmed: ${txId}`);
      return txId;
    } catch (e: any) {
      // A revert is a decision by the chain, not a transient failure. Falling
      // into the timeout branch would re-check a status we already have and
      // then rethrow the same thing.
      if (e instanceof TransactionRevertedError) throw e;

      // If timeout, check if it actually succeeded
      if (e.message?.includes('timeout') || e.name === 'TransactionExpiredTimeoutError') {
        console.log(`[Tx] Confirmation timed out, checking signature status...`);

        // Give it a bit more time then check status
        await new Promise(resolve => setTimeout(resolve, 5000));

        const status = await this.connection.getSignatureStatus(txId, {
          searchTransactionHistory: true,
        });

        if (status.value?.confirmationStatus === 'confirmed' ||
            status.value?.confirmationStatus === 'finalized') {
          if (status.value.err) {
            throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.value.err)}`);
          }
          console.log(`[Tx] Actually succeeded: ${txId}`);
          return txId;
        }

        // Still not confirmed, throw the original error
        throw e;
      }
      throw e;
    }
  }
}

export default JitoService;
