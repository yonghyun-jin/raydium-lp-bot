// Confirmation and dry-run simulation. Nothing here sends a transaction.

import {
  Connection,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  AddressLookupTableAccount,
} from '@solana/web3.js';
import { parseTransactionError } from '../errors';

/**
 * Verify transaction succeeded on-chain
 */
export async function verifyTransaction(
  connection: Connection,
  txId: string,
  timeoutMs: number = 30000
): Promise<{
  success: boolean;
  error?: string;
  errorCode?: number;
  retryable?: boolean;
  explanation?: string;
}> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const status = await connection.getSignatureStatus(txId);

      if (status.value?.confirmationStatus === 'confirmed' ||
          status.value?.confirmationStatus === 'finalized') {
        if (status.value.err) {
          // Transaction confirmed but failed - parse the error
          const errorStr = JSON.stringify(status.value.err);
          const parsed = parseTransactionError(errorStr);
          return {
            success: false,
            error: errorStr,
            errorCode: parsed.errorCode ?? undefined,
            retryable: parsed.retryable,
            explanation: parsed.explanation,
          };
        }
        // Transaction confirmed and succeeded
        return { success: true };
      }

      if (status.value?.err) {
        const errorStr = JSON.stringify(status.value.err);
        const parsed = parseTransactionError(errorStr);
        return {
          success: false,
          error: errorStr,
          errorCode: parsed.errorCode ?? undefined,
          retryable: parsed.retryable,
          explanation: parsed.explanation,
        };
      }
    } catch (e) {
      // RPC error, continue waiting
    }

    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  return {
    success: false,
    error: 'Transaction confirmation timeout',
    retryable: true,
    explanation: 'Transaction was not confirmed within timeout. Will retry.',
  };
}

/**
 * Compile any SDK build result's instructions and simulate them without sending.
 *
 * Throws with the parsed program error if the simulation fails, so a dry run
 * reports exactly what a real attempt would have hit -- for free. Used by both
 * the open and close paths; it only needs the SDK result's `builder`.
 */
export async function simulateBuiltTransaction(
  connection: Connection,
  payer: PublicKey,
  sdkResult: any,
  label: string
): Promise<void> {
  const builder = sdkResult?.builder;
  if (!builder) {
    throw new Error(`[DRY_RUN] SDK returned no builder for ${label}, cannot simulate`);
  }

  const { blockhash } = await connection.getLatestBlockhash('confirmed');

  const lookupTableAddresses: PublicKey[] = builder.lookupTableAddress || [];
  let lookupTableAccounts: AddressLookupTableAccount[] = [];
  if (lookupTableAddresses.length > 0) {
    const results = await Promise.all(
      lookupTableAddresses.map(async (addr: PublicKey) => {
        const result = await connection.getAddressLookupTable(addr);
        return result.value;
      })
    );
    lookupTableAccounts = results.filter((a): a is AddressLookupTableAccount => a !== null);
  }

  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: builder.allInstructions,
  });
  const transaction = new VersionedTransaction(message.compileToV0Message(lookupTableAccounts));

  console.log(`[DRY_RUN] Simulating ${label} (nothing will be sent)...`);
  const sim = await connection.simulateTransaction(transaction, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: 'confirmed',
  });

  if (sim.value.err) {
    const encoded = JSON.stringify(sim.value.err);
    const parsed = parseTransactionError(encoded);
    const logs = (sim.value.logs || []).slice(-15).join('\n');
    throw new Error(
      `[DRY_RUN] Simulation failed: ${encoded} :: ${parsed.explanation}\n${logs}`
    );
  }

  console.log(
    `[DRY_RUN] Simulation clean. Compute units consumed: ${sim.value.unitsConsumed ?? 'n/a'}`
  );
}
