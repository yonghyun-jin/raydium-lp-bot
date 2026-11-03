// Raydium Bot Configuration

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import bs58 from 'bs58';
import dotenv from 'dotenv';

dotenv.config();

// Token Mints
export const TOKENS = {
  SOL: new PublicKey('So11111111111111111111111111111111111111112'),
  USDC: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  // Devnet USDC (different address)
  USDC_DEV: new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
};

// Network Configuration
export const NETWORK = {
  RPC_URL: process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
  WS_URL: process.env.SOLANA_WS_URL || 'wss://api.devnet.solana.com',
  IS_DEVNET: (process.env.SOLANA_RPC_URL || 'devnet').includes('devnet'),
};

// Pool Configuration
export const POOL = {
  ID: process.env.POOL_ID || '',
};

// Strategy Configuration
export const STRATEGY = {
  RANGE_PERCENT: parseFloat(process.env.RANGE_PERCENT || '0.01'),
  // REMOVED: CHECK_INTERVAL. It read CHECK_INTERVAL_SECONDS while both env
  // files set CHECK_INTERVAL_MS, so the documented value was silently ignored
  // -- and nothing consumed the result anyway. The interval that actually runs
  // is DEFAULT_CONFIG.monitorIntervalMs in src/telegram/types.ts, a source
  // literal changeable by neither env name. See scopes/D1-automation-policy.md.
  /**
   * 0.3%. A CONSTANT, not a setting -- there is deliberately no
   * `process.env.MAX_SLIPPAGE` read.
   *
   * `.env.example` used to advertise `MAX_SLIPPAGE=0.01` with nothing reading
   * it, so the documented value and the executed value differed by 3.3x on a
   * spend path with no log line saying the setting was ignored. Wiring the env
   * read would have silently TRIPLED live slippage tolerance, so the doc was
   * corrected to match the code instead. 0.3% is the value the working
   * positions were opened at; the 19 historical failures were a sizing bug, not
   * a slippage one, so there is no evidence for loosening it.
   *
   * If this ever becomes configurable it belongs with the other spend
   * thresholds -- see docs/v1/scopes/D1-automation-policy.md -- and must fail
   * closed on an unreadable value.
   */
  MAX_SLIPPAGE: 0.003,

  /**
   * How much PRICE IMPACT a swap may pay, as a rate.
   *
   * This is the one number on the swap path that is a POLICY, not a fact, and
   * saying so is the point. The other two terms in the price band are
   * properties of the trade -- the pool's own fee, read from the pool, and the
   * quote-to-fill allowance already sent to the router. Impact is what the
   * operator is willing to lose to move the market, and no amount of reading
   * the pool derives a preference.
   *
   * 1% because at the sizes this bot trades, a route needing more than that
   * against a liquid SOL/USDC pool is a bad route rather than an expensive
   * trade. It is NOT a slippage setting and must not be tuned as one: raising
   * it does not make trades more likely to succeed, it makes bad prices more
   * likely to be accepted.
   *
   * Belongs with the other spend thresholds when they become configurable --
   * see docs/v1/scopes/D1-automation-policy.md -- and must fail closed there.
   */
  MAX_PRICE_IMPACT: 0.01,
  MIN_SOL_RESERVE: 0.1, // Keep 0.1 SOL for gas
  USE_JITO: process.env.USE_JITO !== 'false', // MEV protection (default: true)
  // Tick array search range: how many tick arrays to check on each side of current price
  // For tickSpacing=4: 20 arrays = ±4800 ticks ≈ -38% to +62% price range
  // Increase if pool has sparse liquidity far from current price
  TICK_ARRAY_SEARCH_RANGE: parseInt(process.env.TICK_ARRAY_SEARCH_RANGE || '20'),
};

// Safety Configuration
// Every transaction-sending path routes through assertSendAllowed() in ./guard.
// These are read lazily (via getters) so tests can mutate process.env after import.
export const SAFETY = {
  /** Build and simulate transactions, but never send them. */
  get DRY_RUN(): boolean {
    return process.env.DRY_RUN === 'true';
  },
  /** Master switch. Without it, nothing reaches the chain. */
  get ALLOW_REAL_MONEY(): boolean {
    return process.env.ALLOW_REAL_MONEY === 'true';
  },
  /** Hard ceiling on the USD value of a single position. */
  get MAX_POSITION_USD(): number {
    // A bare parseFloat fails OPEN: 'unlimited' -> NaN, and `amount > NaN` is
    // false, so the cap would vanish. An unreadable value keeps the default.
    return readPositiveFloat(process.env.MAX_POSITION_USD, 25);
  },
};

/**
 * Read a positive float from the environment, or fall back.
 *
 * FAILS CLOSED in the sense that matters here: an unreadable or non-positive
 * value yields the default rather than 0 or NaN. A NaN tip silently becomes
 * `lamports: NaN`, which fails to serialize and takes the whole bundle with it;
 * a 0 tip is a bundle no leader will ever select.
 */
function readPositiveFloat(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * Jito bundle tip bounds, in SOL.
 *
 * WIRED ON PURPOSE, unlike MAX_SLIPPAGE above -- and the reason is the opposite
 * one. There, wiring the documented env read would have silently tripled live
 * slippage tolerance. Here the documented value was never read at all, and what
 * shipped instead was the source default of 10,000 lamports: EXACTLY the 50th
 * percentile of Jito's landed tips. A coin-flip tip was protecting four-figure
 * rebalances, and on 2026-09-25 it lost twice in a row -- six bundle
 * submissions across four regions, zero inclusions, a position closed and
 * $1031.18 left sitting in the wallet undeployed.
 *
 * These are BOUNDS, not the tip. The tip itself is sized off Jito's live
 * tip_floor endpoint (see sizeTipLamports in ./jito); this floor is what it
 * falls back to when that endpoint is unreachable, and the ceiling is what
 * stops a congestion spike from bidding the wallet away. The 99th percentile
 * runs ~0.0056 SOL, so 0.002 is deliberately below it: at that point the tip is
 * no longer a rounding error on the trade and a human should decide.
 */
export const JITO = {
  /** Fallback tip, and the lower bound on a market-sized one. */
  get TIP_SOL_FLOOR(): number {
    return readPositiveFloat(process.env.JITO_TIP_SOL, 0.0001);
  },
  /** Hard ceiling. No market reading can bid above this. */
  get TIP_SOL_MAX(): number {
    return readPositiveFloat(process.env.JITO_TIP_SOL_MAX, 0.002);
  },
  /**
   * Wall-clock ceiling for one send, across every blockhash window.
   *
   * TUNABLE because what it buys changed. It was 90s on the reasoning that a
   * Jupiter quote goes stale, and that was right while a rebuild REUSED the
   * first quote -- spending longer only bid with a deader minimum-out. Each
   * window now re-quotes and re-runs the price guard (see jupiterSwap), so the
   * extra time buys fresh attempts instead of staler ones, and a climb that
   * needs four minutes can have them.
   *
   * Raising this requires the Telegraf handlerTimeout to be raised with it, or
   * the operator sees "Promise timed out after 90000 milliseconds" mid-send
   * while the real work carries on behind it.
   */
  get TOTAL_BUDGET_MS(): number {
    return readPositiveFloat(process.env.JITO_TOTAL_BUDGET_MS, 240_000);
  },
  /** How many fresh-quote, fresh-blockhash windows to climb through. */
  get MAX_WINDOWS(): number {
    return readPositiveFloat(process.env.JITO_MAX_WINDOWS, 8);
  },
  /**
   * After this many Jito windows fail, send the next one over plain RPC.
   *
   * THE ANSWER TO "IT NEVER LANDS AND THEN THE MONEY IS STRANDED." The RPC
   * fallback existed, but it was reachable only after the whole budget was
   * spent -- by which point `blockhashStillValid` is false and it correctly
   * REFUSES, because a dead transaction can only produce a signature nobody can
   * confirm. So the one path that does not need to win an auction was never
   * taken. Measured 2026-10-13: a Jupiter-minted blockhash lives ~28s (ours
   * ~36s), which is 4-5 rungs, and three windows of that produced
   * `BlockhashExpiredError` and $3,636.90 idle, twice.
   *
   * A fallback window REBUILDS first, so it sends a transaction that is alive.
   * Safety: it is the SAME signed bytes any pending bundle carries, and Solana
   * rejects a duplicate signature, so at most one can execute -- the same
   * property the rung ladder already relies on.
   *
   * The cost is MEV exposure on that one send, BOUNDED by the quote's on-chain
   * minimum-out (MAX_SLIPPAGE, 0.3%) -- about $5 on a $1,670 swap of the
   * deepest pair on Solana. Against four figures sitting undeployed for hours,
   * that is the trade. Set to a very large number to disable and go back to
   * Jito-or-nothing.
   */
  get RPC_FALLBACK_AFTER_WINDOWS(): number {
    return readPositiveFloat(process.env.JITO_RPC_FALLBACK_AFTER_WINDOWS, 2);
  },
};

// Load wallet from environment
// Supports both WALLET_PRIVATE_KEY (base58 from Phantom) and WALLET_PATH (JSON file)
export function loadWallet(): Keypair {
  // Method 1: Direct private key (base58)
  const privateKey = process.env.WALLET_PRIVATE_KEY;
  if (privateKey && privateKey.trim()) {
    try {
      const decoded = bs58.decode(privateKey.trim());
      return Keypair.fromSecretKey(decoded);
    } catch (error) {
      throw new Error(`Invalid WALLET_PRIVATE_KEY: ${error}`);
    }
  }

  // Method 2: JSON file path
  // No default path: falling back to whatever Solana CLI keypair is on this
  // machine would sign with a wallet nobody chose for the bot.
  const walletPath = process.env.WALLET_PATH;
  if (!walletPath) {
    throw new Error('No wallet configured. Set WALLET_PRIVATE_KEY or WALLET_PATH in .env');
  }

  const fullPath = walletPath.startsWith('~')
    ? path.join(process.env.HOME || '', walletPath.slice(1))
    : walletPath;

  if (!fs.existsSync(fullPath)) {
    throw new Error(`Wallet file not found: ${fullPath}. Set WALLET_PRIVATE_KEY or WALLET_PATH in .env`);
  }

  const keypairData = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
  return Keypair.fromSecretKey(Uint8Array.from(keypairData));
}

// Create connection
export function createConnection(): Connection {
  // Only override the websocket endpoint when one is EXPLICITLY configured.
  //
  // web3.js derives the websocket url from the RPC url when you leave it alone,
  // which is what you want. This used to pass NETWORK.WS_URL unconditionally,
  // and that value defaulted to devnet INDEPENDENTLY of RPC_URL -- so a mainnet
  // RPC silently got a devnet websocket. Railway sets SOLANA_RPC_URL and not
  // SOLANA_WS_URL, so production ran exactly that pairing.
  //
  // Everything that confirms over a subscription rather than http then waits for
  // a notification that can never arrive: `connection.confirmTransaction`, and
  // the Raydium SDK's `sendAndConfirm: true`, which rejects with `undefined`
  // after 60s -- making a transaction that LANDED look like a failure.
  const explicitWs = process.env.SOLANA_WS_URL;
  return new Connection(NETWORK.RPC_URL, {
    commitment: 'confirmed',
    ...(explicitWs ? { wsEndpoint: explicitWs } : {}),
  });
}

// Export default config
export const config = {
  tokens: TOKENS,
  network: NETWORK,
  pool: POOL,
  strategy: STRATEGY,
  safety: SAFETY,
  jito: JITO,
  loadWallet,
  createConnection,
};

export default config;
