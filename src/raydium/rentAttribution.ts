/**
 * Which lamports were RENT, out of everything a transaction moved.
 *
 * Kept apart from the client for the same reason `ledgerRows` is kept apart
 * from the Orchestrator: the rule is the interesting part and it is easier to
 * be sure of on its own — and, unlike anything reachable through the client, it
 * can be tested without a wallet or an RPC.
 *
 * THE RULE: rent is what STAYS in an account that still exists.
 *
 * That definition is a fix for two bugs real transactions found while the fake
 * was entirely green:
 *
 *   1. Summing `createAccountWithSeed` lamports as rent. On a position open
 *      that instruction creates the temporary wSOL account HOLDING THE SOL
 *      BEING DEPOSITED (`wrapAndUnwrapSol`), so 0.047 SOL of deposit was
 *      reported as rent against 0.0046 of real rent — ten times over, in the
 *      wrong category.
 *   2. Reading a closed account's PRE-TRANSACTION balance, which is 0 for an
 *      account created inside that same transaction. The wSOL account
 *      therefore reported rent going out and nothing coming back.
 *
 * Both summed correctly and passed `verifyEffects`. The money really moved;
 * only the label was wrong, and that check compares totals, so it is blind to
 * it. They were found by dumping parsed instructions against a real signature.
 *
 * A third form was missed for longer: rent funded by a plain `system/transfer`
 * rather than by `createAccount`. Metaplex pre-derives the position NFT's
 * metadata PDA and then FUNDS it that way, so 0.0137 SOL per open -- three
 * times all the other rent combined -- looked like an ordinary transfer and
 * was booked nowhere.
 *
 * Telling that apart from the operator simply moving their own money is only
 * possible because of a scoping fact: THIS LEDGER RECORDS THE LP STRATEGY, and
 * the bot books only transactions it sent itself. A wallet-to-wallet transfer
 * happens in a transaction the bot never touches, so it cannot reach here.
 * Inside a bot transaction, SOL leaving for a third party is a cost.
 */

export interface ParsedLike {
  program?: string;
  parsed?: { type?: string; info?: Record<string, any> };
}

export interface RentAttribution {
  rentDeposited: number;
  rentReclaimed: number;
  /** SOL sent to a tip account. Never comes back, so never rent. */
  tipPaid: number;
  /** The accounts each figure came from, so a surprising number can be chased. */
  openedAccounts: string[];
  closedAccounts: string[];
}

/**
 * @param instructions top-level AND inner, already flattened. Inner ones are
 *   not optional: an ATA is created by a CPI from the associated-token
 *   program, so the `createAccount` that actually moves the rent appears only
 *   there, and top-level alone reports zero rent on every swap that opens one.
 * @param me this wallet, as a base58 string.
 * @param lamportsBefore / lamportsAfter account pubkey -> lamports. Missing
 *   means 0, which is right: an account absent from the transaction's keys
 *   held nothing in it.
 */
export function attributeRent(
  instructions: ParsedLike[],
  me: string,
  lamportsBefore: (account: string) => number,
  lamportsAfter: (account: string) => number,
  /**
   * Accounts whose transfers are TIPS, not rent -- a validator tip buys
   * inclusion and never comes back, so calling it rent would hide a permanent
   * cost inside a figure that nets to zero over a position's life.
   */
  tipAccounts: ReadonlySet<string> = new Set()
): RentAttribution {
  const created = new Set<string>();
  const closed = new Set<string>();
  /** Accounts we funded by transfer rather than by createAccount. */
  const fundedByTransfer = new Map<string, number>();
  let tipPaid = 0;

  for (const ix of instructions) {
    const parsed = ix?.parsed;
    if (!parsed || typeof parsed !== 'object') continue;
    const info = parsed.info ?? {};

    if (
      ix.program === 'system' &&
      (parsed.type === 'createAccount' || parsed.type === 'createAccountWithSeed') &&
      info.source === me &&
      info.newAccount
    ) {
      created.add(String(info.newAccount));
      continue;
    }

    if (
      ix.program === 'spl-token' &&
      parsed.type === 'closeAccount' &&
      info.destination === me &&
      info.account
    ) {
      closed.add(String(info.account));
      continue;
    }

    // SOL leaving for a third party inside one of OUR transactions. It is
    // never the operator moving their own money -- that happens in
    // transactions this ledger never sees -- so it is either a tip or rent
    // for an account somebody else derived.
    if (
      ix.program === 'system' &&
      parsed.type === 'transfer' &&
      info.source === me &&
      info.destination &&
      info.destination !== me &&
      typeof info.lamports === 'number'
    ) {
      const to = String(info.destination);
      if (tipAccounts.has(to)) {
        tipPaid += info.lamports / 1e9;
      } else {
        fundedByTransfer.set(to, (fundedByTransfer.get(to) ?? 0) + info.lamports / 1e9);
      }
    }
  }

  const openedAccounts: string[] = [];
  let rentDeposited = 0;
  for (const account of created) {
    // Opened and shut inside this transaction: the lamports came straight
    // back, so no rent was left anywhere. Whatever passed through it is
    // principal, and is booked as principal. This is the wSOL wrap.
    if (closed.has(account)) continue;
    openedAccounts.push(account);
    rentDeposited += lamportsAfter(account) / 1e9;
  }

  for (const [account, sol] of fundedByTransfer) {
    // Same rule as above: what STAYS is rent. If the account was also closed
    // back to us in this transaction, nothing stayed.
    if (closed.has(account)) continue;
    openedAccounts.push(account);
    rentDeposited += sol;
  }

  const closedAccounts: string[] = [];
  let rentReclaimed = 0;
  for (const account of closed) {
    if (created.has(account)) continue;
    closedAccounts.push(account);
    rentReclaimed += lamportsBefore(account) / 1e9;
  }

  return { rentDeposited, rentReclaimed, tipPaid, openedAccounts, closedAccounts };
}
