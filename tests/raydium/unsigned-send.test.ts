/**
 * An unsigned transaction is never sent.
 *
 * WHY THIS EXISTS, in the words the operator saw:
 *
 *   Auto-creation failed: Transaction was not confirmed in 30.00 seconds. It is
 *   unknown if it succeeded or failed. Check signature 1111111111111111111111
 *   111111111111111111111111111111111111 using the Solana Explorer
 *
 * `1111...1111` is base58 of 64 zero bytes -- the signature slot a
 * `VersionedTransaction` is born with. `sendTransaction` sent it, the RPC
 * accepted the bytes, and then nothing could ever confirm them. "Unknown if it
 * succeeded" is the worst answer available on a money path, and here it was not
 * even true: an unsigned transaction provably cannot execute.
 *
 * The cause was the RPC fallback added the same day. It returns from the window
 * loop BEFORE the `transaction.sign([this.wallet])` line in that loop's body, so
 * it handed on a freshly rebuilt and never-signed transaction. Signing now
 * happens at the send itself, where no caller can route around it.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { assertSigned } from '../../src/raydium/jito';

const jito = fs.readFileSync(path.join(__dirname, '../../src/raydium/jito.ts'), 'utf8');

/** A real v0 transaction, signed or not, with no network involved. */
function build(sign: boolean): VersionedTransaction {
  const payer = Keypair.generate();
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    // Any 32-byte base58 string is a structurally valid blockhash.
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }),
    ],
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  if (sign) tx.sign([payer]);
  return tx;
}

describe('assertSigned', () => {
  it('refuses the default all-zero signature', () => {
    const tx = build(false);

    // The precise shape of the bug: the slot exists and is all zeros, which is
    // why nothing threw and the send went out.
    expect(tx.signatures.length).toBe(1);
    expect(tx.signatures[0].every((b) => b === 0)).toBe(true);

    expect(() => assertSigned(tx)).toThrow(/UNSIGNED/);
    // It must say no money moved, because that is the part the operator could
    // not tell from "unknown if it succeeded or failed".
    expect(() => assertSigned(tx)).toThrow(/no money moved/);
  });

  it('accepts a signed transaction', () => {
    expect(() => assertSigned(build(true))).not.toThrow();
  });
});

describe('the plain send signs at the send', () => {
  it('signs and asserts before handing bytes to the RPC', () => {
    const fn = jito.slice(jito.indexOf('private async sendNormalTransaction'));
    const body = fn.slice(0, fn.indexOf('\n  private ', 1));

    const sign = body.indexOf('transaction.sign([this.wallet])');
    const assert = body.indexOf('assertSigned(transaction)');
    const send = body.indexOf('this.connection.sendTransaction(');

    expect(sign).toBeGreaterThan(-1);
    expect(assert).toBeGreaterThan(sign);
    expect(send).toBeGreaterThan(assert);
  });
});
