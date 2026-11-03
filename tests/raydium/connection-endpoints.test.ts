/**
 * The websocket endpoint must never contradict the RPC endpoint.
 *
 * WHY: `createConnection` passed `wsEndpoint: NETWORK.WS_URL` unconditionally,
 * and WS_URL defaulted to `wss://api.devnet.solana.com` INDEPENDENTLY of
 * RPC_URL. Railway sets SOLANA_RPC_URL and not SOLANA_WS_URL, so production ran
 * a mainnet RPC against a devnet websocket -- and nobody would think to look,
 * because the mismatch came from a default rather than from a setting.
 *
 * Everything that confirms over a subscription instead of http then waits for a
 * notification that can never arrive. The Raydium SDK's `sendAndConfirm: true`
 * is the worst case: it rejects with `undefined` after 60s, so a transaction
 * that LANDED is reported as a failure.
 */

const RPC = 'SOLANA_RPC_URL';
const WS = 'SOLANA_WS_URL';

function loadConnection(env: Record<string, string | undefined>) {
  const saved = { [RPC]: process.env[RPC], [WS]: process.env[WS] };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  jest.resetModules();
  try {
    // config.ts calls dotenv.config() at module load, which would re-populate
    // whatever this test just cleared from the developer's own .env -- so the
    // test would measure that machine's configuration instead of the code. It
    // caught a real devnet WS there, but that belongs in a different test.
    jest.doMock('dotenv', () => ({ __esModule: true, default: { config: () => ({}) } }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { config } = require('../../src/raydium/config');
    return config.createConnection();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    jest.resetModules();
  }
}

describe('createConnection endpoints', () => {
  it('derives the websocket from the RPC url when none is configured', () => {
    // This is the production shape: RPC set, WS unset.
    const conn = loadConnection({
      [RPC]: 'https://api.mainnet-beta.solana.com',
      [WS]: undefined,
    });
    expect(conn.rpcEndpoint).toBe('https://api.mainnet-beta.solana.com');
    // web3.js derives wss://api.mainnet-beta.solana.com/ -- same network.
    expect((conn as any)._rpcWsEndpoint).toMatch(/^wss:\/\/api\.mainnet-beta\.solana\.com/);
    // The specific regression: a devnet socket behind a mainnet RPC.
    expect((conn as any)._rpcWsEndpoint).not.toMatch(/devnet/);
  });

  it('still honours an explicitly configured websocket', () => {
    // Some providers serve the socket on a different host, so the override stays.
    const conn = loadConnection({
      [RPC]: 'https://api.mainnet-beta.solana.com',
      [WS]: 'wss://custom.example.com',
    });
    expect((conn as any)._rpcWsEndpoint).toBe('wss://custom.example.com');
  });

  it('keeps devnet on devnet', () => {
    const conn = loadConnection({ [RPC]: 'https://api.devnet.solana.com', [WS]: undefined });
    expect((conn as any)._rpcWsEndpoint).toMatch(/devnet/);
  });
});
