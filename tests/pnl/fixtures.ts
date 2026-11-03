/**
 * Ledger rows with the exact shape the bot writes, identifiers replaced.
 *
 * The adopted position matters even though it is unusual: `/done` adopts a
 * position the bot did not open, which produces the no-open shape again the
 * moment it is used.
 *
 * These four operations cover every case the decomposition has to get
 * right:
 *
 *   job_1699999990000   an ADOPTED position -- close rows, no open at all
 *   op_1700000010000    a complete $10 cycle that LOST money to fixed costs
 *   op_1700000011000    the complete $1,000 cycle whose decomposition is
 *                       independently derived by hand
 *   op_1700000012000    swap + open, still open, no close yet
 *
 * The $1,000 cycle is the one that makes these fixtures worth keeping: its
 * answer was derived once by hand and written down before this code existed,
 * so the test checks the arithmetic against something other than itself.
 */

import type { PnlRow, PositionContext } from '../../src/pnl';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const POOL = '3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv';

/**
 * Real transaction signatures, so the tx grouping is exercised against the
 * shape production actually produces: one operation spanning several
 * signatures, each carrying 4-6 rows.
 */
export const TX = {
  adoptedClose: '3MnUXXXCNP7ftmy81k3jcXoMY6WqJAHKaToghJDNNarSHHHSBH6etJsiaKasQxgj6PviQATE5iBQyj9EzUS115k6',
  smallOpen: '4FpqVReV6waLEJgZLjC95y16NsHwwa9muy9bRLQPLiDZuhi7HP5R7D3b2ADTBKM7sWsYhEt2pyCWJHCpWNKQXbzy',
  smallClose: '3uywdDMNdjEJZRW91YaKLCc14kw5XYxKruwiqNMybtpW3E1Gpurdn8sUZsnM8P2oeHEPon1xXgrA5BAkJpxsiUci',
  largeOpen: '3NbV3ymqStXwBTmpAjsSEfYiVNBntq4eEwWx3cwwcxFHEufmvRiCgwLHWfijFz1qxhEWeXMSGP67eKemwPgGJ14Q',
  largeClose: '56osw8Wh3EGgi1v7ppyzWA4Gy8EyFy1ahyBsRu6uAuDsP8BvNpMazz2KfkaZHpKDmN2D76jMyChfWV8SS7c98k9D',
  openSwap: 'oPQGQRbPxfNYR8d5ECaiGR2n47SMvbQ8tY32y5dMEwE9iDTnN1RnriVWY9kfZNsn1VTc9jK916SLsqwwrwgwgXM',
  openCreate: '4z1sTXET8m95h2ifKF22itLhueEVSzzawW7s5GVB1ouqWKNfBgGv4b5qFvdraFUvr8XWHG6wkbFbBXmxWGd5hquj',
} as const;

function row(
  operationId: string,
  timestamp: string,
  action: string,
  category: string,
  token: 'SOL' | 'USDC',
  amount: number,
  priceUsd: number,
  positionId: string | null = null,
  txId = 'tx_synthetic',
  description: string | null = null
): PnlRow {
  return {
    operationId,
    txId,
    timestamp: new Date(timestamp),
    action,
    category,
    protocol: action === 'swap' ? 'jupiter' : 'raydium',
    chain: 'solana',
    description,
    token,
    tokenAddress: token === 'SOL' ? SOL : USDC,
    amount,
    priceUsd,
    valueUsd: amount * priceUsd,
    positionId,
  };
}

/** Adopted position: it was closed by this bot but opened before the ledger existed. */
export const ADOPTED_CLOSE_ONLY: PnlRow[] = [
  row('job_1699999990000', '2026-09-21T14:03:13.042Z', 'close_lp', 'principal', 'SOL', 0.001804, 118.53, '2Yk7HT', TX.adoptedClose),
  row('job_1699999990000', '2026-09-21T14:03:13.042Z', 'close_lp', 'reward', 'SOL', 0.000428, 118.53, '2Yk7HT', TX.adoptedClose),
  row('job_1699999990000', '2026-09-21T14:03:13.042Z', 'close_lp', 'principal', 'USDC', 9.883052, 1, '2Yk7HT', TX.adoptedClose),
  row('job_1699999990000', '2026-09-21T14:03:13.042Z', 'close_lp', 'reward', 'USDC', 0.049629, 1, '2Yk7HT', TX.adoptedClose),
  row('job_1699999990000', '2026-09-21T14:03:13.042Z', 'close_lp', 'network_fee', 'SOL', -0.000125, 118.53, '2Yk7HT', TX.adoptedClose),
  row('job_1699999990000', '2026-09-21T14:03:13.042Z', 'close_lp', 'rent_reclaim', 'SOL', 0.001488, 118.53, '2Yk7HT', TX.adoptedClose),
];

/** A complete $10 cycle. It lost money, and almost all of it was unrecovered rent. */
export const SMALL_COMPLETE: PnlRow[] = [
  row('op_1700000010000_ad4dc638', '2026-09-21T14:03:22.247Z', 'create_lp', 'principal', 'SOL', -0.049365, 118.53, 'ELTJP7', TX.smallOpen),
  row('op_1700000010000_ad4dc638', '2026-09-21T14:03:22.247Z', 'create_lp', 'principal', 'USDC', -4.117488, 1, 'ELTJP7', TX.smallOpen),
  row('op_1700000010000_ad4dc638', '2026-09-21T14:03:22.247Z', 'create_lp', 'network_fee', 'SOL', -0.00031, 118.53, 'ELTJP7', TX.smallOpen),
  row('op_1700000010000_ad4dc638', '2026-09-21T14:03:22.247Z', 'create_lp', 'rent_deposit', 'SOL', -0.018367, 118.53, 'ELTJP7', TX.smallOpen),
  row('op_1700000010000_ad4dc638', '2026-09-21T18:17:59.108Z', 'close_lp', 'principal', 'SOL', 0.057451, 117.56, 'ELTJP7', TX.smallClose),
  row('op_1700000010000_ad4dc638', '2026-09-21T18:17:59.108Z', 'close_lp', 'reward', 'SOL', 0.000079, 117.56, 'ELTJP7', TX.smallClose),
  row('op_1700000010000_ad4dc638', '2026-09-21T18:17:59.108Z', 'close_lp', 'principal', 'USDC', 3.364077, 1, 'ELTJP7', TX.smallClose),
  row('op_1700000010000_ad4dc638', '2026-09-21T18:17:59.108Z', 'close_lp', 'reward', 'USDC', 0.009047, 1, 'ELTJP7', TX.smallClose),
  row('op_1700000010000_ad4dc638', '2026-09-21T18:17:59.108Z', 'close_lp', 'network_fee', 'SOL', -0.000125, 117.56, 'ELTJP7', TX.smallClose),
  row('op_1700000010000_ad4dc638', '2026-09-21T18:17:59.108Z', 'close_lp', 'rent_reclaim', 'SOL', 0.001488, 117.56, 'ELTJP7', TX.smallClose),
];

/**
 * The $1,000 cycle. SOL went $116.78 -> $122.78 while it was open.
 *
 * Headline +$35.87, of which +$28.98 was the market and +$6.90 was the bot.
 */
export const LARGE_COMPLETE: PnlRow[] = [
  row('op_1700000011000_94d730b0', '2026-09-22T06:35:38.376Z', 'create_lp', 'principal', 'SOL', -4.835403, 116.78, '3kN8EF', TX.largeOpen),
  row('op_1700000011000_94d730b0', '2026-09-22T06:35:38.376Z', 'create_lp', 'principal', 'USDC', -428.838571, 1, '3kN8EF', TX.largeOpen),
  row('op_1700000011000_94d730b0', '2026-09-22T06:35:38.376Z', 'create_lp', 'network_fee', 'SOL', -0.00031, 116.78, '3kN8EF', TX.largeOpen),
  row('op_1700000011000_94d730b0', '2026-09-22T06:35:38.376Z', 'create_lp', 'rent_deposit', 'SOL', -0.018367, 116.78, '3kN8EF', TX.largeOpen),
  row('op_1700000011000_94d730b0', '2026-09-25T20:39:43.389Z', 'close_lp', 'principal', 'SOL', 0.001773, 122.78, '3kN8EF', TX.largeClose),
  row('op_1700000011000_94d730b0', '2026-09-25T20:39:43.389Z', 'close_lp', 'reward', 'SOL', 0.096396, 122.78, '3kN8EF', TX.largeClose),
  row('op_1700000011000_94d730b0', '2026-09-25T20:39:43.389Z', 'close_lp', 'principal', 'USDC', 1007.859371, 1, '3kN8EF', TX.largeClose),
  row('op_1700000011000_94d730b0', '2026-09-25T20:39:43.389Z', 'close_lp', 'reward', 'USDC', 11.489883, 1, '3kN8EF', TX.largeClose),
  row('op_1700000011000_94d730b0', '2026-09-25T20:39:43.389Z', 'close_lp', 'network_fee', 'SOL', -0.000125, 122.78, '3kN8EF', TX.largeClose),
  row('op_1700000011000_94d730b0', '2026-09-25T20:39:43.389Z', 'close_lp', 'rent_reclaim', 'SOL', 0.001488, 122.78, '3kN8EF', TX.largeClose),
];

/** Funding swap plus the open it paid for. Still open -- no close rows. */
export const STILL_OPEN: PnlRow[] = [
  row('op_1700000012000_a65a3231', '2026-09-26T05:02:27.720Z', 'swap', 'principal', 'USDC', -545.258363, 1, null, TX.openSwap),
  row('op_1700000012000_a65a3231', '2026-09-26T05:02:27.720Z', 'swap', 'principal', 'SOL', 4.519024, 120.66, null, TX.openSwap),
  row('op_1700000012000_a65a3231', '2026-09-26T05:02:27.720Z', 'swap', 'execution_slippage', 'SOL', -0.000194, 120.66, null, TX.openSwap),
  row('op_1700000012000_a65a3231', '2026-09-26T05:02:27.720Z', 'swap', 'network_fee', 'SOL', -0.000105, 120.66, null, TX.openSwap),
  row('op_1700000012000_a65a3231', '2026-09-26T05:02:31.386Z', 'create_lp', 'principal', 'SOL', -4.586119, 120.67, '5t5YFi', TX.openCreate),
  row('op_1700000012000_a65a3231', '2026-09-26T05:02:31.386Z', 'create_lp', 'principal', 'USDC', -442.929621, 1, '5t5YFi', TX.openCreate),
  row('op_1700000012000_a65a3231', '2026-09-26T05:02:31.386Z', 'create_lp', 'network_fee', 'SOL', -0.00031, 120.67, '5t5YFi', TX.openCreate),
  row('op_1700000012000_a65a3231', '2026-09-26T05:02:31.386Z', 'create_lp', 'rent_deposit', 'SOL', -0.018367, 120.67, '5t5YFi', TX.openCreate),
];

/** Everything production held on 2026-09-28. */
export const ALL_ROWS: PnlRow[] = [
  ...ADOPTED_CLOSE_ONLY,
  ...SMALL_COMPLETE,
  ...LARGE_COMPLETE,
  ...STILL_OPEN,
];

export { SOL, USDC, row };

/**
 * The `positions` rows for these operations, as production holds them.
 *
 * This is the only source of the LP range -- `range_lower`/`range_upper` never
 * reach `ledger_entries`, and `operation_id` is the only safe join between the
 * two tables. Note `3kN8EF` closed at $122.78 against an upper bound of
 * $122.75: it had just gone out of range, which is why it came back almost
 * entirely USDC.
 */
export const POSITIONS: PositionContext[] = [
  {
    operationId: 'job_1699999990000',
    nftMint: '2Yk7HT',
    poolId: POOL,
    rangeLower: 105.97,
    rangeUpper: 118.54,
    isOpen: false,
    openedAt: new Date('2026-09-19T06:01:25.419Z'),
    adoptedAt: null,
    closedAt: new Date('2026-09-21T14:03:12.798Z'),
    prevPositionId: null,
    // Copied 2026-09-28, before the monitor recorded readings, so every
    // one of these is genuinely absent rather than set to a placeholder.
    lastReadAt: null,
    lastPrice: null,
    lastSolAmount: null,
    lastUsdcAmount: null,
    lastFeesUsd: null,
    lastInRange: null,
  },
  {
    operationId: 'op_1700000010000_ad4dc638',
    nftMint: 'ELTJP7',
    poolId: POOL,
    rangeLower: 113.4,
    rangeUpper: 126.22,
    isOpen: false,
    openedAt: new Date('2026-09-21T14:03:22.017Z'),
    adoptedAt: null,
    closedAt: new Date('2026-09-21T18:17:58.883Z'),
    prevPositionId: '2Yk7HT',
    // Copied 2026-09-28, before the monitor recorded readings, so every
    // one of these is genuinely absent rather than set to a placeholder.
    lastReadAt: null,
    lastPrice: null,
    lastSolAmount: null,
    lastUsdcAmount: null,
    lastFeesUsd: null,
    lastInRange: null,
  },
  {
    operationId: 'op_1700000011000_94d730b0',
    nftMint: '3kN8EF',
    poolId: POOL,
    rangeLower: 112.52,
    rangeUpper: 122.75,
    isOpen: false,
    openedAt: new Date('2026-09-22T06:35:38.194Z'),
    adoptedAt: null,
    closedAt: new Date('2026-09-25T20:39:43.172Z'),
    prevPositionId: null,
    // Copied 2026-09-28, before the monitor recorded readings, so every
    // one of these is genuinely absent rather than set to a placeholder.
    lastReadAt: null,
    lastPrice: null,
    lastSolAmount: null,
    lastUsdcAmount: null,
    lastFeesUsd: null,
    lastInRange: null,
  },
  {
    operationId: 'op_1700000012000_a65a3231',
    nftMint: '5t5YFi',
    poolId: POOL,
    rangeLower: 116.27,
    rangeUpper: 126.41,
    isOpen: true,
    openedAt: new Date('2026-09-26T05:02:31.172Z'),
    adoptedAt: null,
    closedAt: null,
    prevPositionId: null,
    // Copied 2026-09-28, before the monitor recorded readings, so every
    // one of these is genuinely absent rather than set to a placeholder.
    lastReadAt: null,
    lastPrice: null,
    lastSolAmount: null,
    lastUsdcAmount: null,
    lastFeesUsd: null,
    lastInRange: null,
  },
];
