// Telegram Bot Types

/*
 * REMOVED: `interface BotState` -- the shape of `.telegram-state/bot-state.json`,
 * which no longer exists.
 *
 * Where each field went, because the reasoning matters more than the list:
 *   chatId            -> bot_states.telegram_chat_id  (resolveChatId)
 *   investmentAmount  -> bot_states.investment_amount (getInvestmentAmount, fails closed)
 *   positionNftMint   -> positions.nft_mint           (resolveActiveMint)
 *   isMonitoring      -> bot_states.is_monitoring, as INTENT read once at boot;
 *                        whether the loop runs is the interval handle
 *   stage             -> an in-memory field on LPBot. Genuinely session state:
 *                        both readers fail closed when it is lost
 *   positionOpenedAt  -> positions.opened_at. It had five writers and zero
 *                        readers here -- age already came from Postgres
 *   userId            -> nothing. The auth middleware settles identity before
 *                        any handler runs
 *   solAmount, usdcAmount, startedAt, lastNotification
 *                     -> nothing. Declared here and given Postgres columns;
 *                        never populated on either side
 *
 * The file was not on the Railway volume, so every redeploy erased it while the
 * position it described stayed live on-chain.
 */


/**
 * Where the operator is in THIS conversation. Nothing else.
 *
 * It had seven values, of which two were ever read. The other five were
 * written twenty-one times and read zero, shadowing job state the Orchestrator
 * owns -- and a stage the bot writes and never consults cannot go stale
 * loudly, it just disagrees with the chain in silence.
 *
 * Both survivors gate a conversational step and both FAIL CLOSED when lost: a
 * restart drops AWAITING_CONFIRMATION so `/confirm` refuses rather than spends,
 * and drops AWAITING_AMOUNT so the next text is ignored. That is why this lives
 * in memory and not in Postgres.
 */
export type UserStage = 'IDLE' | 'AWAITING_AMOUNT' | 'AWAITING_CONFIRMATION';

/**
 * What is waiting to be redeployed, for the operator rather than for a decision.
 *
 * A SUMMARY, not the recovery state itself: nothing spends off this, so unlike
 * every reader on the money path it is allowed to render partial knowledge. The
 * caller passes `null` for the whole object when the state could not be read,
 * which is why `idleUsd` being null here means "read it, nothing stranded"
 * rather than "could not tell" -- the two answers reach the message by
 * different routes because they call for different sentences.
 */
export interface StrandSummary {
  /** Dollars sitting in the wallet from a completed close, or null if none. */
  idleUsd: number | null;
  /** Does the operator still want a position to exist? */
  wanted: boolean;
  attemptsUsed: number;
  attemptLimit: number;
}

export interface WalletBalance {
  sol: number;
  usdc: number;
  solUsd: number;
  usdcUsd: number;
  totalUsd: number;
}

export interface PositionStatus {
  inRange: boolean;
  currentPrice: number;
  rangeLower: number;
  rangeUpper: number;
  /**
   * Fees earned so far in USD, or null when they cannot be established.
   *
   * Same rule as ageHours: unknown is not zero. Fees need the pool state and
   * both boundary tick accounts, so an RPC failure leaves them genuinely
   * unknown -- and "$0.00" is exactly the reading an operator would act on.
   */
  feesEarned: number | null;
  /**
   * Hours since the position opened, or null when that cannot be established.
   *
   * Null is a real answer: an adopted position has no recoverable open time
   * (age is not stored on-chain), and the database may be unreachable. It must
   * never be coerced to 0 -- age gates a rebalance that happens WITHOUT asking,
   * so unknown has to route to "ask", not to "brand new".
   */
  ageHours: number | null;
  /**
   * What the position is worth right now in USD, principal plus uncollected
   * fees, or null when it cannot be established.
   *
   * `getPositionDetails` already computes this on every tick and the status
   * threw it away, which is why an open position could be shown no capital
   * figure at all -- and why $1,000 of drift between the allocated amount and
   * the deployed amount stayed invisible for weeks. Carrying it costs no extra
   * chain call. Null for the usual reason: a partial reading is not a figure.
   */
  valueUsd: number | null;
  nftMint: string;
}

/**
 * The range the bot would use next: in v0, the live price +/- 4%.
 * NOT a view on direction.
 */
export interface RangeSuggestion {
  /** False when no range could be set; the bounds are then not a suggestion. */
  available: boolean;
  rangeLower: number;
  rangeUpper: number;
  /** Width of the suggested range, as a percentage. */
  widthPct: number;
  /** Share of the deposit that must be SOL, forced by CLMM maths. */
  solRatioPct: number;
  reason: string;
}

export interface BotConfig {
  token: string;
  monitorIntervalMs: number;
  minPositionDurationHours: number;
  targetPositionDurationHours: number;
  failureLimitPerDay: number;
  poolId: string;
}

// Default SOL-USDC pool on Raydium mainnet (0.01% fee tier)
export const DEFAULT_POOL_ID = '2QdhepnKRTLjjSqPL1PtKNwqrUkoLee5Gqs8bvZhRdMv';

export const DEFAULT_CONFIG: Omit<BotConfig, 'token'> = {
  monitorIntervalMs: 30000,
  minPositionDurationHours: 6,
  targetPositionDurationHours: 24,
  failureLimitPerDay: 3,
  poolId: DEFAULT_POOL_ID,
};
