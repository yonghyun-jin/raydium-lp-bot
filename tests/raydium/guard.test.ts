/**
 * Guardrail tests.
 *
 * These assert that a test process cannot spend money, cannot reach the
 * network, and cannot get hold of the real wallet key — by construction rather
 * than by convention.
 */

import { assertSendAllowed, isSendAllowed, SendBlockedError } from '../../src/raydium/guard';
import '../../src/raydium/config'; // triggers dotenv.config(), as production does

describe('assertSendAllowed', () => {
  it('refuses to send from a test process, whatever the env says', () => {
    // The unconditional backstop: JEST_WORKER_ID is set by the runner.
    process.env.ALLOW_REAL_MONEY = 'true';
    process.env.DRY_RUN = 'false';
    try {
      expect(() => assertSendAllowed('a real swap')).toThrow(SendBlockedError);
      expect(() => assertSendAllowed('a real swap')).toThrow(/test process/);
    } finally {
      process.env.ALLOW_REAL_MONEY = 'false';
      process.env.DRY_RUN = 'true';
    }
  });

  it('names what it blocked, so the log says which call site tripped', () => {
    expect(() => assertSendAllowed('createPosition: SDK execute')).toThrow(
      /createPosition: SDK execute/
    );
  });

  it('isSendAllowed reports false rather than throwing', () => {
    expect(isSendAllowed()).toBe(false);
  });
});

describe('no-money setup', () => {
  it('REGRESSION: the real wallet key does not leak in via dotenv', () => {
    // tests/setup/no-money.ts BLANKS these rather than deleting them. Deleting
    // is not enough: config.ts calls dotenv.config() at import time, and dotenv
    // repopulates any key that is absent from process.env.
    expect(process.env.WALLET_PRIVATE_KEY).toBe('');
    expect(process.env.WALLET_PATH).toBe('/nonexistent/no-wallet.json');
  });

  it('the RPC endpoint is not a real one', () => {
    expect(process.env.SOLANA_RPC_URL).toMatch(/127\.0\.0\.1/);
  });

  it('outbound fetch is blocked', async () => {
    await expect(fetch('https://api.mainnet-beta.solana.com')).rejects.toThrow(
      /Network blocked in unit tests/
    );
  });
});
