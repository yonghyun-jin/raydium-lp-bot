/**
 * Jito bundle encoding tests.
 *
 * The base58-vs-base64 bug was fixed three times — f1dea64 ("use base58 not
 * base64"), f9205b8, 675ba29 — and never had a test. Base64 makes the block
 * engine answer "transaction could not be decoded".
 */

import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';

import {
  encodeBundle,
  JITO_TIP_ACCOUNTS,
  JITO_ENDPOINTS,
  JITO_TIP_FLOOR_URL,
  clampTipSol,
  parseTipFloorSol,
  shuffled,
} from '../../src/raydium/jito';

// A deterministic, offline transaction. Never signed by a funded key, never sent.
function makeTx(lamports: number): VersionedTransaction {
  const payer = Keypair.generate();
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    // Any 32-byte base58 string works as a blockhash for serialization purposes.
    recentBlockhash: bs58.encode(Buffer.alloc(32, 7)),
    instructions: [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: new PublicKey(JITO_TIP_ACCOUNTS[0]),
        lamports,
      }),
    ],
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

describe('encodeBundle', () => {
  const mainTx = makeTx(1);
  const tipTx = makeTx(10_000);

  it('REGRESSION: encodes as base58, not base64', () => {
    const [main, tip] = encodeBundle(mainTx, tipTx);

    // Decoding as base58 must reproduce the exact wire bytes.
    expect(Buffer.from(bs58.decode(main))).toEqual(Buffer.from(mainTx.serialize()));
    expect(Buffer.from(bs58.decode(tip))).toEqual(Buffer.from(tipTx.serialize()));
  });

  it('REGRESSION: the encoding is distinguishable from base64', () => {
    const [main] = encodeBundle(mainTx, tipTx);
    const base64 = Buffer.from(mainTx.serialize()).toString('base64');

    expect(main).not.toBe(base64);
    // base58's alphabet excludes 0, O, I, l and the base64 padding characters.
    expect(main).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    expect(main).not.toMatch(/[+/=]/);
  });

  it('puts the tip transaction last, as the block engine requires', () => {
    const bundle = encodeBundle(mainTx, tipTx);

    expect(bundle).toHaveLength(2);
    expect(Buffer.from(bs58.decode(bundle[1]))).toEqual(Buffer.from(tipTx.serialize()));
  });
});

describe('Jito constants', () => {
  it('every tip account is a valid public key', () => {
    expect(JITO_TIP_ACCOUNTS.length).toBeGreaterThan(0);
    for (const account of JITO_TIP_ACCOUNTS) {
      expect(() => new PublicKey(account)).not.toThrow();
    }
  });

  it('every endpoint is an https bundles URL', () => {
    expect(JITO_ENDPOINTS.mainnet.length).toBeGreaterThan(0);
    for (const endpoint of JITO_ENDPOINTS.mainnet) {
      expect(endpoint).toMatch(/^https:\/\/.+\/api\/v1\/bundles$/);
    }
  });

  it('tip accounts are distinct, so random selection actually spreads', () => {
    expect(new Set(JITO_TIP_ACCOUNTS).size).toBe(JITO_TIP_ACCOUNTS.length);
  });
});

/**
 * The tip that could not land.
 *
 * `tipLamports: 10000` shipped as the source default while `JITO_TIP_SOL=0.0001`
 * sat in .env and in Railway production with NO process.env reader anywhere. So
 * the tip was 10,000 lamports -- about $0.0012, and exactly the 50th percentile
 * of Jito's landed tips. On 2026-09-25 that lost twice in a row: six bundle
 * submissions across four block engines, zero inclusions, a healthy position
 * closed and $1031.18 left sitting in the wallet undeployed.
 */
describe('parseTipFloorSol', () => {
  // The real shape, from https://bundles.jito.wtf/api/v1/bundles/tip_floor
  const real = [
    {
      time: '2026-09-26T01:01:57+00:00',
      landed_tips_25th_percentile: 6.0040000000000005e-6,
      landed_tips_50th_percentile: 1e-5,
      landed_tips_75th_percentile: 4.9108500000000006e-5,
      landed_tips_95th_percentile: 0.000389929799999995,
      landed_tips_99th_percentile: 0.005641990000000078,
      ema_landed_tips_50th_percentile: 1.364279611527127e-5,
    },
  ];

  it('reads the 95th percentile out of the array form', () => {
    expect(parseTipFloorSol(real)).toBeCloseTo(0.0003899298, 10);
  });

  it('REGRESSION: the value is SOL, not lamports', () => {
    // Reading 0.00039 as lamports is a 1e9 error in the direction of tipping
    // nothing at all -- the precise failure this whole change exists to fix.
    const sol = parseTipFloorSol(real)!;
    expect(sol).toBeLessThan(1);
    expect(Math.round(sol * 1e9)).toBe(389930);
  });

  it('accepts a bare object as well as an array', () => {
    expect(parseTipFloorSol(real[0])).toBeCloseTo(0.0003899298, 10);
  });

  it.each([
    ['empty array', []],
    ['null', null],
    ['no percentile field', [{ time: 'x' }]],
    ['a string percentile', [{ landed_tips_95th_percentile: '0.0004' }]],
    ['zero', [{ landed_tips_95th_percentile: 0 }]],
    ['negative', [{ landed_tips_95th_percentile: -1 }]],
    ['NaN', [{ landed_tips_95th_percentile: NaN }]],
  ])('returns null for %s rather than a bad tip', (_label, payload) => {
    expect(parseTipFloorSol(payload)).toBeNull();
  });

  it('reads from Jito’s published endpoint', () => {
    expect(JITO_TIP_FLOOR_URL).toBe('https://bundles.jito.wtf/api/v1/bundles/tip_floor');
  });
});

describe('clampTipSol', () => {
  const FLOOR = 0.0001;
  const MAX = 0.002;

  it('uses the market reading when it sits inside the bounds', () => {
    expect(clampTipSol(0.00039, FLOOR, MAX)).toBeCloseTo(0.00039, 10);
  });

  it('never tips below the floor, even when the market is cheap', () => {
    // 0.00001 SOL is the median -- the value that shipped, and a coin flip.
    expect(clampTipSol(0.00001, FLOOR, MAX)).toBe(FLOOR);
  });

  it('never tips above the ceiling, whatever congestion does', () => {
    // The 99th percentile runs ~0.0056 SOL. A spike must not bid the wallet away.
    expect(clampTipSol(0.0056, FLOOR, MAX)).toBe(MAX);
  });

  it('falls back to the floor when the market cannot be read', () => {
    expect(clampTipSol(null, FLOOR, MAX)).toBe(FLOOR);
  });

  it.each([[0], [-1], [NaN], [Infinity]])(
    'treats %p as unreadable rather than as a tip',
    value => {
      expect(clampTipSol(value, FLOOR, MAX)).toBe(FLOOR);
    }
  );

  it('an inverted configuration resolves to the ceiling, not to a throw', () => {
    // Refusing to send would strand funds mid-rebalance, which is worse than a
    // capped tip -- that is the failure this change exists to prevent.
    expect(clampTipSol(0.001, 0.002, 0.0005)).toBe(0.002);
    expect(clampTipSol(null, 0.002, 0.0005)).toBe(0.002);
  });

  it('the chosen tip clears the median by a wide margin', () => {
    const median = 1e-5;
    expect(clampTipSol(0.000389929799999995, FLOOR, MAX)).toBeGreaterThan(median * 10);
  });
});

describe('shuffled', () => {
  it('returns every element exactly once', () => {
    const input = [1, 2, 3, 4, 5];
    const out = shuffled(input);
    expect(out).toHaveLength(input.length);
    expect([...out].sort()).toEqual([...input].sort());
  });

  it('does not mutate its argument', () => {
    const input = [1, 2, 3, 4, 5];
    shuffled(input);
    expect(input).toEqual([1, 2, 3, 4, 5]);
  });

  it('samples WITHOUT replacement, unlike the endpoint picker it replaced', () => {
    // getRandomEndpoint drew tokyo, tokyo, mainnet on a real three-attempt
    // ladder. Walking a shuffle makes a repeat impossible below the list length.
    for (let trial = 0; trial < 200; trial++) {
      const walk = shuffled(JITO_ENDPOINTS.mainnet).slice(0, 3);
      expect(new Set(walk).size).toBe(3);
    }
  });
});
