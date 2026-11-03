/**
 * Rehearse opening a position, without sending anything.
 *
 * Runs the REAL path — the real Orchestrator, the real client, the real
 * predictor, the real database — right up to the chain.
 *
 * WHAT DRY_RUN ACTUALLY DOES, because it is not what it sounds like: the
 * create does not stop at the guard. `client.ts` takes a SIMULATE branch and
 * asks the validator to run the transaction without committing it, then
 * returns `txId: 'DRY_RUN'`. So a clean rehearsal proves more than "we would
 * have tried" — it proves the transaction the bot built is one the program
 * accepts, at the tick arrays and deposit ratio it actually computed. That is
 * the check the 19 failed positions never had.
 *
 * A path that DOES hit the guard instead (a swap, say) is equally fine. Both
 * outcomes are reported; neither is a failure.
 *
 * WHAT THIS CANNOT REHEARSE, and it matters: everything C3 added reads a
 * LANDED transaction. No send means no signature, so `getTransactionEffects`,
 * the cost rows and `verifyEffects` are never reached. A green rehearsal says
 * the path up to the send is sound; it says nothing about the accounting that
 * follows it. Only a real open does, and `scripts/inspect-transaction-effects.ts`
 * is how to check it afterwards.
 *
 *   DRY_RUN=true npx ts-node scripts/rehearse-open.ts [investmentUsd]
 *   DRY_RUN=true npx ts-node scripts/rehearse-open.ts [investmentUsd] <lower> <upper>
 *
 * The second form SUPPLIES the range instead of using the fixed v0 range, to
 * rehearse a specific range.
 *
 * A supplied range rehearses LESS. Say so out loud rather than reading a green
 * run as though the model had been exercised.
 */

import { config } from '../src/raydium/config';
import { SendBlockedError } from '../src/raydium/guard';
import { Orchestrator } from '../src/orchestrator/Orchestrator';

function heading(text: string) {
  console.log(`\n${'─'.repeat(72)}\n${text}\n${'─'.repeat(72)}`);
}

async function main() {
  const investmentUsd = Number(process.argv[2] ?? 10);
  const lower = process.argv[3] ? Number(process.argv[3]) : undefined;
  const upper = process.argv[4] ? Number(process.argv[4]) : undefined;
  const suppliedRange = lower !== undefined && upper !== undefined;

  if ((lower === undefined) !== (upper === undefined)) {
    console.error('Supply BOTH bounds or neither.');
    process.exit(1);
  }

  heading('Safety');

  // Refuse to run WITHOUT the guard on. A rehearsal that can spend is not a
  // rehearsal, and the point of this file is that it is safe to run without
  // thinking about it.
  if (!config.safety.DRY_RUN) {
    console.error(
      'DRY_RUN is not set. This script exists to rehearse, so it refuses to\n' +
        'run in a configuration where a send could actually go through.\n\n' +
        '  DRY_RUN=true npx ts-node scripts/rehearse-open.ts'
    );
    process.exit(1);
  }

  console.log(`  DRY_RUN            ${config.safety.DRY_RUN}`);
  console.log(`  ALLOW_REAL_MONEY   ${config.safety.ALLOW_REAL_MONEY}`);
  console.log(`  MAX_POSITION_USD   ${config.safety.MAX_POSITION_USD}`);
  console.log(`  pool               ${config.pool.ID}`);
  console.log(`  rehearsing         $${investmentUsd}`);
  console.log(
    `  range              ${suppliedRange ? `${lower} - ${upper} (SUPPLIED -- the fixed v0 range is NOT used)` : 'fixed v0 range (live price ±4%)'}`
  );

  heading('Running the real path');

  const report = () => {
    console.log(
      `What ran for real: ${suppliedRange ? 'the deposit sizing,' : 'the prediction, the deposit sizing,'} the budget ceiling and the daily cap.`
    );
    if (suppliedRange) {
      console.log(
        'The RANGE WAS SUPPLIED, so the fixed v0 range was not used. This run\n' +
          'says nothing about whether a prediction would have been available.'
      );
    }
    console.log(
      '\nWhat did NOT run: the accounting. Every cost row and verifyEffects reads\n' +
        'a LANDED transaction, and a rehearsal produces no signature. Check those\n' +
        'after a real open with:\n' +
        '  npx ts-node scripts/inspect-transaction-effects.ts'
    );
  };

  const orchestrator = new Orchestrator();

  try {
    if (suppliedRange) {
      await orchestrator.createPositionManual({
        poolId: config.pool.ID,
        priceLower: lower!,
        priceUpper: upper!,
        investmentUsd,
      });
    } else {
      await orchestrator.createNewPosition({
        poolId: config.pool.ID,
        investmentUsd,
      });
    }

    heading('REHEARSAL CLEAN');
    console.log(
      'The create was SIMULATED against the validator and came back clean, so\n' +
        'the transaction the bot built is one the program accepts -- at the tick\n' +
        'arrays and the deposit ratio it actually computed. Nothing was sent:\n' +
        "the txId is the literal 'DRY_RUN', and the Orchestrator refused to\n" +
        'record a position that does not exist on-chain.\n'
    );
    report();
  } catch (error: any) {
    if (error instanceof SendBlockedError || /GUARD/.test(String(error?.message))) {
      heading('Stopped at the guard');
      console.log(`  ${error.message}`);
      console.log(
        '\nAlso a good outcome. Some sends simulate under DRY_RUN and some are\n' +
          'refused outright; either way no money moved.\n'
      );
      report();
      return;
    }


    heading('FAILED BEFORE THE GUARD');

    if (/Prediction unavailable/.test(String(error?.message))) {
      console.error(
        'No range could be set (usually: no live pool price). Check SOLANA_RPC_URL\n' +
          'and POOL_ID, or rehearse the rest of the path with a supplied range:\n\n' +
          `  DRY_RUN=true npx ts-node scripts/rehearse-open.ts ${investmentUsd} <lower> <upper>\n\n` +
          'Refusing to invent a range is the correct behaviour and must not be\n' +
          '"fixed" by adding a fallback.\n'
      );
    } else {
      console.error(
        'This is a real failure in the path that runs before any money moves.\n'
      );
    }
    console.error(error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
