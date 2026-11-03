/**
 * The recording layer must never be able to break trading.
 *
 * Its whole reason for existing is an asymmetry (docs/v1/database-schema.md):
 * writes degrade, reads that gate spending fail closed. If a write could throw,
 * a Postgres hiccup would turn a successful on-chain position into a failed
 * call -- and the money has already moved, so refusing to continue does not
 * un-move it.
 *
 * These run with JEST_WORKER_ID set, which is itself one of the properties
 * under test: recording is OFF in a test process, so importing the money path
 * pulls in no Prisma client and needs no database.
 */

import {
  recordPositionOpened,
  recordPositionClosed,
  getPositionAgeHours,
} from '../../src/recording';

const OPENED = {
  nftMint: 'TestMint111111111111111111111111111111111111',
  poolId: 'TestPool1111111111111111111111111111111111',
  rangeLower: 96.88,
  rangeUpper: 104.38,
  solDeposited: 0.0545,
  usdcDeposited: 4.53,
};

describe('writes degrade, never throw', () => {
  it('recordPositionOpened resolves even with no database configured', async () => {
    await expect(recordPositionOpened(OPENED)).resolves.toBeUndefined();
  });

  it('recordPositionClosed resolves even with no database configured', async () => {
    await expect(recordPositionClosed('TestMint111', {})).resolves.toBeUndefined();
    await expect(
      recordPositionClosed('TestMint111', { solWithdrawn: 1, usdcWithdrawn: 2 })
    ).resolves.toBeUndefined();
  });

  it('survives a DATABASE_URL that points nowhere', async () => {
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://nobody@127.0.0.1:1/nope';
    try {
      // Still a no-op because this is a test process -- which is the point:
      // the test-process check is evaluated before anything is loaded.
      await expect(recordPositionOpened(OPENED)).resolves.toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = saved;
    }
  });
});

describe('age reads fail closed', () => {
  it('returns null rather than a number when age cannot be established', async () => {
    // Null is the answer for all of: no row, adopted position with no known
    // open time, and an unreachable database. The caller's response to each is
    // identical -- ask the user -- which is why they are not distinguished.
    await expect(getPositionAgeHours('NoSuchMint')).resolves.toBeNull();
  });

  it('never returns 0 for an unknown age', async () => {
    // The bug this replaces: `positionOpenedAt ?? 0` made a 20h position read
    // as brand new after a redeploy, routing it into the under-6h branch.
    const age = await getPositionAgeHours('NoSuchMint');
    expect(age).not.toBe(0);
  });
});

describe('recording cannot block the money path indefinitely', () => {
  // A try/catch bounds FAILURE, not SLOWNESS, and slowness is the worse of the
  // two: these calls sit between an on-chain action and the code that reports
  // it. Measured against a black-hole IP (packets dropped, no RST), the write
  // blocked 5114ms with the ceiling in place. Without it the wait is whatever
  // Prisma and the OS agree on.
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '../../src/recording/index.ts'),
    'utf8'
  );

  it('races every write against a timeout', () => {
    expect(source).toMatch(/RECORDING_TIMEOUT_MS/);
    const attempt = source.slice(source.indexOf('async function attempt('));
    expect(attempt.slice(0, attempt.indexOf('\n}'))).toMatch(/Promise\.race/);
  });

  it('races the age read too, since it sits in the 30s loop', () => {
    const read = source.slice(source.indexOf('export async function getPositionAgeHours'));
    expect(read).toMatch(/Promise\.race/);
  });

  it('clears the timer, so a successful write does not hold the event loop open', () => {
    // A pending setTimeout keeps Node alive for the full ceiling after every
    // call that succeeded quickly.
    expect((source.match(/clearTimeout\(timer\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('recording is inert in a test process', () => {
  it('does not load @prisma/client', () => {
    // If the facade leaked, this module would appear in the require cache after
    // the calls above. Tests must not need a database, and must not pay to
    // construct a Prisma client that connects to nothing.
    const loaded = Object.keys(require.cache).some((k) => k.includes('.prisma/client'));
    expect(loaded).toBe(false);
  });
});
