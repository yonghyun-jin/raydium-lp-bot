/**
 * Jest global setup: make it structurally impossible for a unit test to spend
 * money or depend on the network.
 *
 * Loaded via `setupFiles` in jest.config.js, so it runs before every test file.
 *
 * Network-dependent tests live in `*.live.test.ts` and run under
 * jest.live.config.js, which does NOT load this file.
 */

// No wallet: RaydiumClient's constructor calls loadWallet(), which will now throw
// loudly rather than quietly signing something.
//
// These are BLANKED, not deleted. src/raydium/config.ts calls dotenv.config()
// at import time, and dotenv only skips a key that is already present in
// process.env -- so deleting them lets the real .env put the wallet key back.
process.env.WALLET_PRIVATE_KEY = '';
process.env.WALLET_PATH = '/nonexistent/no-wallet.json';

// No usable RPC.
process.env.SOLANA_RPC_URL = 'http://127.0.0.1:1/blocked';
process.env.SOLANA_WS_URL = 'ws://127.0.0.1:1/blocked';

// Belt and braces alongside guard.ts's JEST_WORKER_ID check.
process.env.DRY_RUN = 'true';
process.env.ALLOW_REAL_MONEY = 'false';

// Keep dotenv's banner out of test output.
process.env.DOTENV_CONFIG_QUIET = 'true';

// Block outbound HTTP. Opt in per-suite with ALLOW_NETWORK=1 (the live config sets it).
const realFetch = globalThis.fetch;
globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
  if (process.env.ALLOW_NETWORK === '1') {
    return realFetch(...args);
  }
  const url = typeof args[0] === 'string' ? args[0] : String((args[0] as Request)?.url ?? args[0]);
  return Promise.reject(
    new Error(
      `Network blocked in unit tests: ${url}\n` +
        `Mock it, or move this test to a *.live.test.ts file (npm run test:live).`
    )
  );
}) as typeof fetch;
