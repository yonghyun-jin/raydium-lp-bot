/**
 * CommonJS shim for `uuid`.
 *
 * uuid v14 (pulled in transitively by rpc-websockets <- @solana/web3.js) ships
 * ESM only, which Jest cannot `require`. Only `v1()` is actually used, and only
 * to label a websocket that never opens in tests, so a UUID from node's crypto
 * is a faithful stand-in.
 *
 * This is the "ESM compatibility issue" the old tests/orchestrator suite cited
 * as the reason the money path could not be tested at all.
 */
const { randomUUID } = require('crypto');

const v4 = () => randomUUID();

module.exports = {
  v1: v4,
  v3: v4,
  v4,
  v5: v4,
  v6: v4,
  v7: v4,
  NIL: '00000000-0000-0000-0000-000000000000',
  validate: (value) =>
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
  version: (value) => parseInt(String(value).charAt(14), 16),
  parse: (value) => Uint8Array.from(Buffer.from(String(value).replace(/-/g, ''), 'hex')),
  stringify: (bytes) => Buffer.from(bytes).toString('hex'),
};
