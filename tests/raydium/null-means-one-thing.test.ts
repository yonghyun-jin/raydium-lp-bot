/**
 * "Not found on-chain" must mean the position is gone, and nothing else.
 *
 * `getPositionDetails` had two `return null` paths: the position is not ours,
 * and the POOL could not be read. The caller reports null as
 * `Position ... not found on-chain`, so the second one reported a healthy $999
 * position as missing — every 30s, while the Raydium REST API rate-limited the
 * monitoring loop on the public endpoint.
 *
 * Nothing was destroyed (`if (!status) return;`), but the position was
 * effectively unmonitored and the log said the opposite of what was true.
 */

import * as fs from 'fs';
import * as path from 'path';

const client = fs
  .readFileSync(path.join(__dirname, '../../src/raydium/client.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

// Bounded at the next member. An earlier version of this slice overshot and
// counted `return null`s belonging to other methods -- which is how the guard
// reported 5 where the method has 1.
// BRACE-COUNTED, not regex-bounded. The signature spans lines
// (`Promise<{ ... } | null> {`), so every positional end-pattern tried here
// overshot into later methods and counted their `return null`s -- reporting 5
// where the method has 1. Counting braces is the only bound that cannot.
const body = (() => {
  const start = client.search(/async getPositionDetails\(/);
  expect(start).toBeGreaterThan(-1);

  const open = client.indexOf('{', client.indexOf('null> {', start));
  let depth = 0;
  for (let i = open; i < client.length; i++) {
    if (client[i] === '{') depth++;
    else if (client[i] === '}') {
      depth--;
      if (depth === 0) return client.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces in getPositionDetails');
})();

describe('getPositionDetails', () => {
  it('returns null for exactly one reason: the position is not ours', () => {
    const nulls = body.match(/return null;/g) ?? [];
    expect(nulls.length).toBe(1);
  });

  it('that one reason is the position lookup', () => {
    const at = body.indexOf('return null;');
    // The `if (!pos)` immediately precedes it.
    expect(body.slice(Math.max(0, at - 120), at)).toMatch(/if \(!pos\)/);
  });

  it('does not swallow its own errors', () => {
    // It used to end in `catch (e) { console.error(...); return null; }`, so
    // the throw below was caught two lines later and became the same
    // indistinguishable null. Both callers already wrap this in a try/catch
    // that reports honestly; swallowing here only destroyed the distinction.
    // Same shape as getTokenBalance returning 0 on an RPC failure.
    expect(body).not.toMatch(/catch[\s\S]{0,120}return null;/);
  });

  it('an unreadable pool throws, and says the position is untouched', () => {
    const at = body.indexOf('if (!poolInfo)');
    expect(at).toBeGreaterThan(-1);

    const branch = body.slice(at, at + 500);
    expect(branch).toMatch(/throw new Error/);
    // The operator reads this. "Could not price it" and "it is gone" call for
    // completely different responses.
    expect(branch).toMatch(/position itself is untouched/i);
  });
});
