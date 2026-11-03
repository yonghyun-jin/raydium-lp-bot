/**
 * Rent is what STAYS, and the wSOL wrap is not rent.
 *
 * The fixtures below are the real shape of a position open on this project's
 * pool, taken from signature 5md5iKtC… and reduced to the instructions that
 * matter. It is worth knowing that the numbers here were measured, not
 * invented: earlier guesses in this repo put rent at 0.002 SOL and an audit at
 * 0.01, and a first version of this code reported 0.052. The answer is
 * 0.00463296.
 */

import { attributeRent, ParsedLike } from '../../src/raydium/rentAttribution';

const ME = 'DnGMuDaNzG7k8xLsjqU7LDCw6kmRSbA6HHcBqHEacUTB';

const WSOL = 'Aku26J8tg97FPuUyAHseVKiFJZYuYSKAttgVxR8mBwCz';
const NFT_MINT = '9RXMvuKfSN7QfBk83SsAgyrjLiqoyh6ozkU51Vgy61ot';
const NFT_ATA = 'AZUWVe9qLpBym398N9zMJcGS9prkf1nq84T2PGM3kbkU';
const POSITION = '2R18EbQaEXYPzRnoCSqzmMiqLXPuFQyzumUNtvzUh2mF';

const create = (newAccount: string, type = 'createAccount'): ParsedLike => ({
  program: 'system',
  parsed: { type, info: { source: ME, newAccount } },
});

const close = (account: string, destination = ME): ParsedLike => ({
  program: 'spl-token',
  parsed: { type: 'closeAccount', info: { account, destination } },
});

/** Lamports left in each account after a real open. */
const AFTER: Record<string, number> = {
  [NFT_MINT]: 1_066_800,
  [NFT_ATA]: 1_488_440,
  [POSITION]: 2_077_720,
  [WSOL]: 0, // closed in the same transaction
};

const after = (a: string) => AFTER[a] ?? 0;
const nothingBefore = () => 0;

describe('a position open', () => {
  const instructions = [
    // wrapAndUnwrapSol: a temporary account holding the SOL being deposited.
    create(WSOL, 'createAccountWithSeed'),
    close(WSOL),
    create(NFT_MINT),
    create(NFT_ATA),
    create(POSITION),
  ];

  it('reports the measured rent, not the wrapped deposit', () => {
    const { rentDeposited } = attributeRent(instructions, ME, nothingBefore, after);

    // 0.0010668 (NFT mint) + 0.00148844 (its ATA) + 0.00207772 (CLMM personal
    // position). The wSOL account contributes nothing.
    expect(rentDeposited).toBeCloseTo(0.00463296, 9);
  });

  it('does not count the wSOL wrap, whose lamports are the deposit', () => {
    // THE BUG. createAccountWithSeed funded that account with 0.047269 SOL --
    // the SOL going into the position -- and an earlier version summed it as
    // rent, reporting ten times the true figure in the wrong category. It
    // summed correctly against the wallet delta, so verifyEffects passed.
    const { openedAccounts } = attributeRent(instructions, ME, nothingBefore, after);
    expect(openedAccounts).not.toContain(WSOL);
    expect(openedAccounts.sort()).toEqual([NFT_MINT, NFT_ATA, POSITION].sort());
  });

  it('an account opened and shut in one transaction contributes to neither side', () => {
    const wrapOnly = [create(WSOL, 'createAccountWithSeed'), close(WSOL)];
    const r = attributeRent(wrapOnly, ME, nothingBefore, after);

    // Not rent out, and not rent back either. Whatever flowed through it is
    // principal and is booked as principal.
    expect(r.rentDeposited).toBe(0);
    expect(r.rentReclaimed).toBe(0);
  });
});

describe('a close', () => {
  it('reclaims the pre-transaction balance of an account it did not create', () => {
    const before = (a: string) => (a === NFT_ATA ? 1_488_440 : 0);
    const r = attributeRent([close(NFT_ATA)], ME, before, () => 0);

    expect(r.rentReclaimed).toBeCloseTo(0.00148844, 9);
  });

  it('ignores a close whose lamports go to someone else', () => {
    const before = () => 1_488_440;
    const r = attributeRent([close(NFT_ATA, 'SomeoneElse1111111111111111111111111111111')], ME, before, () => 0);

    expect(r.rentReclaimed).toBe(0);
  });
});

const METADATA = '34kMu3KREsR74JG1UbUq1RLzaPBnN1ruRWcHP42a4zpB';
const TIP = 'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY';

const transfer = (destination: string, lamports: number): ParsedLike => ({
  program: 'system',
  parsed: { type: 'transfer', info: { source: ME, destination, lamports } },
});

describe('rent funded by a plain transfer', () => {
  it('counts SOL sent to a program-derived account as rent', () => {
    // THE COST THAT HID THE LONGEST. Metaplex pre-derives the position NFT's
    // metadata PDA and funds it with system/transfer instead of createAccount,
    // so 0.0137 SOL per open -- three times all the other rent combined --
    // looked like an ordinary transfer and was booked nowhere. It was
    // initially mistaken for a Jito tip; the account's owner is the Metaplex
    // token-metadata program, and no Jito tip account matches.
    const r = attributeRent([transfer(METADATA, 13_733_800)], ME, nothingBefore, after);
    expect(r.rentDeposited).toBeCloseTo(0.0137338, 9);
  });

  it('the real open now accounts for every lamport of rent', () => {
    const instructions = [
      create(WSOL, 'createAccountWithSeed'),
      close(WSOL),
      create(NFT_MINT),
      create(NFT_ATA),
      create(POSITION),
      transfer(METADATA, 13_733_800),
    ];

    const r = attributeRent(instructions, ME, nothingBefore, after);
    expect(r.rentDeposited).toBeCloseTo(0.01836676, 9);
  });

  it('a tip is NOT rent, because a tip never comes back', () => {
    const r = attributeRent([transfer(TIP, 100_000)], ME, nothingBefore, after, new Set([TIP]));

    expect(r.rentDeposited).toBe(0);
    expect(r.tipPaid).toBeCloseTo(0.0001, 9);
  });

  it('an account funded by transfer and closed back in the same transaction is not rent', () => {
    const r = attributeRent(
      [transfer(WSOL, 47_268_592), close(WSOL)],
      ME,
      nothingBefore,
      after
    );
    expect(r.rentDeposited).toBe(0);
  });
});

describe('what is deliberately not swept in', () => {
  it('the operator moving their own money never reaches here', () => {
    // A wallet-to-wallet transfer happens in a transaction the bot never sent,
    // and the ledger books only the bot's own transactions -- THIS LEDGER IS
    // THE LP STRATEGY'S. The sweep found three such destinations, all plain
    // wallets holding 1.5, 66 and 71 SOL. They are not costs and must not
    // appear; the scoping is what makes them impossible rather than filtered.
    const botSends = [create(NFT_MINT)];
    expect(attributeRent(botSends, ME, nothingBefore, after).rentDeposited).toBeCloseTo(0.0010668, 9);
  });

  it('an account someone else created is not our rent', () => {
    const theirs: ParsedLike = {
      program: 'system',
      parsed: { type: 'createAccount', info: { source: 'NotUs', newAccount: POSITION } },
    };

    expect(attributeRent([theirs], ME, nothingBefore, after).rentDeposited).toBe(0);
  });

  it('unparsed instructions are skipped rather than guessed at', () => {
    const opaque = { program: 'spl-token', parsed: undefined } as ParsedLike;
    expect(attributeRent([opaque], ME, nothingBefore, after).rentDeposited).toBe(0);
  });
});
