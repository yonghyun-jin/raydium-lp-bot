/**
 * The explanations behind every help icon.
 *
 * Kept in one file rather than inline, because several of them are the only
 * written answer to a question this project had to work out the hard way --
 * why rent does not come back, why fees appear only at the close, why capital
 * in is not the sum of what left the wallet. Losing them in JSX would lose the
 * reasoning.
 */

export interface Explanation {
  title: string;
  body: string;
}

export const EXPLAIN: Record<string, Explanation> = {
  capitalIn: {
    title: 'Capital in',
    body:
      'The deepest this operation was ever out of pocket, following its transactions in order. ' +
      'Not a total of everything that left the wallet: a funding swap moves money around inside ' +
      'the operation before any of it is deployed, so counting both legs would overstate what ' +
      'was really at risk.',
  },
  capitalOut: {
    title: 'Capital out',
    body:
      'What came back to the wallet when the position closed — capital in plus the net result. ' +
      'An operation still running reads "still deployed": its capital is in the pool, not lost ' +
      'and not returned. One with no opening record reads "unknown" — there is no capital-in ' +
      'figure for the return to be added to.',
  },
  feesEarned: {
    title: 'Fees earned',
    body:
      'Trading fees this position collected while the price sat inside its range. They are read ' +
      'from the chain moments before the position is closed and booked once, at the close. ' +
      'Nothing is recorded while a position runs, so an open position shows no earnings even ' +
      'though it is accruing them.',
  },
  feesPaid: {
    title: 'Fees paid',
    body:
      'What it cost to transact: Solana network and priority fees, plus any pool or router fee ' +
      'on a swap. The opposite of fees earned — these move the result the other way, which is ' +
      'why the two are never added together.',
  },
  rent: {
    title: 'Rent',
    body:
      'Solana charges a refundable deposit to create an account and returns it when the account ' +
      'closes. Opening a position creates several — the position NFT, its token account, the ' +
      'pool position account — and that is the locked figure. Most of it does not come back: the ' +
      "NFT's metadata account is funded by a plain transfer that is never reclaimed, so roughly " +
      '$2 per position is a permanent cost no matter how large the position is. On a $1,000 ' +
      'position that is rounding; on a $10 one it is the whole result.',
  },
  solPrice: {
    title: 'SOL price',
    body:
      'The price when the position opened and when it closed. Compare it against the range: ' +
      'inside the range the position earns fees, and once price leaves it the position stops ' +
      'earning and ends up holding entirely one token.',
  },
  heldFor: {
    title: 'Held for',
    body: 'From the moment the position was opened to the moment it was closed.',
  },
  operationId: {
    title: 'Operation ID',
    body:
      'The key that ties one P&L cycle together. The funding swap, the open and the close all ' +
      'carry it, which is what makes them a single result rather than three unrelated transactions.',
  },
  range: {
    title: 'Position range',
    body:
      'The price band this position provides liquidity in — the range ' +
      'the bot opened at. It earns trading fees only while the price is inside it; above the ' +
      'band the position holds entirely stablecoin, below it entirely SOL. Read from the ' +
      'position record rather than the prediction, so a position the bot adopted rather than ' +
      'opened shows the band it was already running at. The Predictions page is where the band ' +
      'is held against what the price actually did.',
  },
  net: {
    title: 'Net P&L',
    body:
      'Everything the operation moved, summed. Shown only when it can honestly be read as a ' +
      'result: an open position shows nothing, because its capital is deployed rather than lost.',
  },
  status: {
    title: 'Status',
    body:
      'Open — still running, so it has no result yet. Closed — finished, and its figures are ' +
      'final. No opening record — this bot closed a position it did not open, so there is no ' +
      'cost to measure the return against. Test run — deliberately excluded from the totals, ' +
      'so its figures are shown but not counted.',
  },

  // Movement categories.
  principal: {
    title: 'Principal',
    body:
      'Your own capital moving. The sign is the wallet’s: negative means it left the wallet, ' +
      'positive means it arrived.',
  },
  reward: {
    title: 'Fees earned',
    body: 'Trading fees the position collected, handed back together with the principal at the close.',
  },
  network_fee: {
    title: 'Network fee',
    body: 'What Solana charged to run the transaction, priority fee included.',
  },
  rent_deposit: {
    title: 'Rent locked',
    body: 'A refundable deposit taken for accounts this transaction created.',
  },
  rent_reclaim: {
    title: 'Rent returned',
    body: 'Deposit given back by accounts this transaction closed. Usually far less than was locked.',
  },
  execution_slippage: {
    title: 'Slippage',
    body:
      'The gap between the output the router quoted and what actually arrived, after the fees it ' +
      'had already declared. It is a worse rate rather than a charge, so nothing is deducted — ' +
      'the principal amount is simply smaller.',
  },
  dex_fee: {
    title: 'Pool fee',
    body: 'The liquidity pools’ own cut, summed across every hop the swap routed through.',
  },
  platform_fee: {
    title: 'Protocol fee',
    body:
      'What a protocol charged for the service itself, separate from the pools and from the ' +
      'network. Two kinds appear here: the router’s own cut on a swap, and the fee Metaplex ' +
      'takes to create the position NFT’s metadata — 0.01 SOL per position, charged by requiring ' +
      'the account to be funded past what it needs to exist. That second one used to be counted ' +
      'as rent, which made it look refundable. It is not: it is the single largest cost of ' +
      'opening a position, and every rebalance pays it again.',
  },
  interest: {
    title: 'Interest paid',
    body: 'Interest charged on borrowed funds.',
  },
  debt: {
    title: 'Debt',
    body:
      'A liability created or settled. Recorded alongside the matching principal row so the pair ' +
      'nets to zero — borrowed money is not income.',
  },
};

/**
 * How a movement category is written for a human.
 *
 * A LOOKUP WITH A FALLBACK, never a branch. An unrecognised category renders as
 * the raw string the ledger holds, which is what keeps this page usable for a
 * protocol nobody has added labels for yet.
 */
export function movementLabel(category: string): string {
  return EXPLAIN[category]?.title ?? category;
}

/**
 * The same, for what a transaction did. Same rule: fallback to the raw action.
 */
const ACTION_LABELS: Record<string, string> = {
  create_lp: 'Opened position',
  close_lp: 'Closed position',
  harvest: 'Collected fees',
  swap: 'Swap',
  supply: 'Supplied',
  withdraw: 'Withdrew',
  borrow: 'Borrowed',
  repay: 'Repaid',
  stake: 'Staked',
  unstake: 'Unstaked',
  claim: 'Claimed',
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

/* Added for the journal view. The debit/credit convention is genuinely
   counter-intuitive against a bank statement, so these two are not optional. */
EXPLAIN.debit = {
  title: 'Debit',
  body:
    'Money arriving in the wallet. In double-entry terms the wallet is an asset account, and a ' +
    'debit increases it. Careful: this is the opposite of your bank statement, which is written ' +
    "from the bank's point of view — there your deposit is their liability, so it shows as a credit.",
};

EXPLAIN.credit = {
  title: 'Credit',
  body:
    'Money leaving the wallet — the asset decreasing. So depositing into a position is a credit ' +
    'here, which again is the reverse of how your bank app words it.',
};

EXPLAIN.balance = {
  title: 'Balance',
  body:
    'A running total of what this operation has done to the wallet, starting at zero and ' +
    'carrying across every transaction. It goes negative while capital is deployed and the final ' +
    'figure is the result — the last balance always equals the Net on the row above, which is ' +
    'what makes the ledger check itself.',
};

/* ---- the prediction review ------------------------------------------- */

EXPLAIN.predictedWidth = {
  title: 'Predicted width',
  body:
    'How wide the range is, as a percentage of the price it was anchored on. Wider ' +
    'is safer against drifting out, and earns less per dollar while in range, because the same ' +
    'capital is spread over more ground.',
};

EXPLAIN.realisedWidth = {
  title: 'The price actually moved',
  body:
    "The distance between the highest and lowest price the market traded during the window, as a " +
    'percentage of the same anchor. Measured on hourly highs and lows, so a spike that reversed ' +
    'within the hour still counts — it is exactly the kind of move that takes a position out of ' +
    'range.',
};

EXPLAIN.coverage = {
  title: 'Band used',
  body:
    'The realised move divided by the predicted width. 100% means the price used exactly the ' +
    'ground the range covered. 20% means four fifths of the range was never visited, and the ' +
    'capital sitting there earned nothing. Above 100% the price went further than the range ' +
    'allowed for.',
};

EXPLAIN.closesInRange = {
  title: 'Hours closing in range',
  body:
    'The share of hourly candles that CLOSED inside the range. It is not true time in range: a ' +
    'price that pokes out and comes back within the hour was out of range for part of it and ' +
    'this cannot see that. Recording real time in range needs the 30-second monitoring loop to ' +
    'write it down, which is scope C2.',
};

EXPLAIN.breach = {
  title: 'Left the range',
  body:
    'The first hour in which the market traded above the top of the range or below the bottom. ' +
    'From that moment the position is earning nothing and is sitting entirely in one of the two ' +
    'tokens — which is why a position that breaks out at the top comes back almost all stablecoin.',
};

EXPLAIN.extremes = {
  title: 'Highest and lowest',
  body:
    'The extremes the market reached during the window, from hourly highs and lows. Compare them ' +
    'against the range above and below the chart to see how much headroom there was at each end.',
};

EXPLAIN.hodl = {
  title: 'If simply held',
  body:
    'What the exact basket you deposited would have been worth at this cycle\u2019s closing ' +
    'price, had it never been deployed. It is the true counterfactual \u2014 those are the ' +
    'tokens the position consumed \u2014 so the gap to it is impermanent loss against the fees ' +
    'you earned.',
};

EXPLAIN.strategy = {
  title: 'The strategy',
  body:
    'LP result minus what holding would have returned. This is the only number that says ' +
    'whether running the bot was worth it. A positive Net in a rising market is mostly the ' +
    'market: fees earned have to cover the impermanent loss from the pool selling your ' +
    'appreciating token on the way up, and over a few hours they often do not. The two lines ' +
    'beneath it are what it is made of \u2014 the impermanent loss, and the fees left after every ' +
    'cost \u2014 and they add to it exactly.',
};

EXPLAIN.marketMove = {
  title: 'Market move',
  body:
    'What the tokens you deposited would have done on their own, if they had never been put in ' +
    'the pool \u2014 just the price moving. It is the part of the result the bot had no say in. ' +
    'Open the row to see the basket valued at both ends.',
};

EXPLAIN.allSol = {
  title: 'If held all SOL',
  body:
    'The same stake, but every dollar of it buying SOL at this cycle’s opening price and ' +
    'just sitting there. A different question from “If simply held” above, which keeps ' +
    'the mix you actually deposited — roughly half stablecoin. Full exposure, so in a ' +
    'falling market this is the worse line and the bot beats it, while in a rising one it is ' +
    'the harder line to beat. The two can disagree about whether the bot helped, and both ' +
    'answers are true: one asks “did LPing beat holding what I put in”, the other ' +
    '“did it beat just buying the coin”.',
};

EXPLAIN.vsAllSol = {
  title: 'Holding all SOL',
  body:
    'The whole stake buying SOL at this cycle\u2019s opening price and sitting there. Full ' +
    'exposure, against the roughly half-stablecoin basket the bot actually held \u2014 so in a ' +
    'falling market the bot beats this almost automatically, and the margin is mostly the ' +
    'exposure it did not take rather than anything the pool earned. The chart above the ' +
    'Operations table carries the line that separates those two.',
};

EXPLAIN.impermanentLoss = {
  title: 'Impermanent loss',
  body:
    'What came back, minus what you put in, both priced at the close. As the price moved ' +
    'through your range the pool traded one token for the other, so the basket that comes out ' +
    'is a different one and it is worth less. It arrives with the SIZE of the price move and ' +
    'arrives all at once, which is why a short cycle can lose while collecting fees quickly. ' +
    'A plus sign is not a gain: it means this operation\u2019s rows do not describe one position.',
};

EXPLAIN.feesAndCosts = {
  title: 'Fees, after costs',
  body:
    'What is left of the fees once everything that charged for the privilege has been paid. ' +
    'Open it for the four parts \u2014 the last one, the funding swap, is the gap between the ' +
    'price recorded on the swap row and what the router actually filled at, and without it the ' +
    'column does not add up. On its own this figure flatters the bot; it only means something ' +
    'against the impermanent loss above, which is what it has to cover.',
};

EXPLAIN.impermanentLossOpen = {
  title: 'Impermanent loss, so far',
  body:
    'What the position holds right now, MINUS your own deposit priced at the same moment. ' +
    'Both sides use the price on the \u201cas of\u201d line, and the amounts are what the ' +
    'chain reported \u2014 not a split worked out from the stored range, which is only the ' +
    'range the bot asked for. It moves with the price and is not a result: nothing is ' +
    'realised until the position closes.',
};

EXPLAIN.feesSoFar = {
  title: 'Fees collected so far',
  body:
    'Unclaimed fees the position had accrued at the last check. This is what has to grow past ' +
    'the impermanent loss beside it before closing beats having held. Unreadable when either ' +
    'token\u2019s fee leg could not be read \u2014 shown as unreadable rather than as zero, ' +
    'because a position earning nothing and a position nobody could measure are different.',
};

EXPLAIN.markedAt = {
  title: 'As of',
  body:
    'When the monitor last read this position, and the SOL price it read. The two figures above ' +
    'are from that moment and nothing refreshes them here \u2014 if this time is old, the bot ' +
    'is not running.',
};
