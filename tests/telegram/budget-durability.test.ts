/**
 * An unreadable deposit budget must REFUSE, never mean "no limit".
 *
 * WHY: `createNewPosition({ investmentUsd })` documents an omitted budget as
 * "deploy the whole wallet" — its historical behaviour. The amount lived in
 * `.telegram-state`, which a redeploy erases, so a lost value did not read as
 * "$10 is missing" but as "no limit". The bot captured an amount from the
 * operator for months with no way to pass it on, and every "$10" request
 * deposited the entire wallet.
 *
 * So this read FAILS CLOSED, and the null check must happen at the call site:
 * `investmentUsd: await getInvestmentAmount()` would forward null into the
 * whole-wallet path and recreate the bug.
 *
 * Scope: docs/v1/scopes/B1-session-state.md, deploy 2.
 */

import * as fs from 'fs';
import * as path from 'path';

function codeOf(rel: string): string {
  return fs
    .readFileSync(path.join(__dirname, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

const bot = codeOf('../../src/telegram/bot.ts');
const types = codeOf('../../src/telegram/types.ts');
const recording = codeOf('../../src/recording/index.ts');

describe('the budget has left the JSON', () => {
  it('is not a field on the v0 BotState', () => {
    expect(types).not.toMatch(/^\s*investmentAmount\s*\??\s*:/m);
  });

  it('nothing reads state.investmentAmount', () => {
    expect(bot).not.toMatch(/state\??\.investmentAmount/);
  });

  it('is persisted before the operator can confirm a deposit', () => {
    const write = bot.indexOf('await recordInvestmentAmount(amount)');
    const confirm = bot.indexOf("this.stage = 'AWAITING_CONFIRMATION'");
    expect(write).toBeGreaterThan(-1);
    expect(confirm).toBeGreaterThan(write);
  });

  it('reads the amount back rather than trusting the write', () => {
    // The recording facade degrades on failure and returns void, so a
    // successful-looking write proves nothing.
    const between = bot.slice(
      bot.indexOf('await recordInvestmentAmount(amount)'),
      bot.indexOf("this.stage = 'AWAITING_CONFIRMATION'")
    );
    expect(between).toMatch(/await getInvestmentAmount\(\)\) === null/);
  });
});

describe('an unreadable budget refuses', () => {
  it('getInvestmentAmount returns null rather than a default', () => {
    const fn = recording.slice(recording.indexOf('export async function getInvestmentAmount'));
    const body = fn.slice(0, fn.indexOf('\nexport ', 1));
    expect(body).toMatch(/return null/);
    // No number may be substituted for an unknown budget.
    expect(body).not.toMatch(/\?\?\s*\d/);
  });

  it('is never forwarded straight into createNewPosition', () => {
    // `investmentUsd: await getInvestmentAmount()` would pass null into the
    // whole-wallet path. Every call site must check first.
    expect(bot).not.toMatch(/investmentUsd:\s*await getInvestmentAmount\(\)/);
  });

  it('every use of the configured amount is null-checked', () => {
    // null means "deploy the whole wallet" downstream, so no read may be used
    // unchecked. Asserting the COUNT alone made this drift: a third read was
    // added for a message and the test failed on the number rather than on the
    // property. Assert the property instead -- every read is compared against
    // null within the same expression or the next line.
    //
    // The three today: the read-back after the operator enters an amount, the
    // first open, and the stale-prompt notice. The rebalance's use moved to
    // the Orchestrator.
    const reads = [...bot.matchAll(/await getInvestmentAmount\(\)/g)];
    expect(reads.length).toBeGreaterThanOrEqual(2);

    for (const read of reads) {
      const after = bot.slice(read.index!, read.index! + 240);
      expect(after).toMatch(/(!==|===)\s*null/);
    }
  });
});

/*
 * The rebalance's budget rules MOVED, not gone.
 *
 * They were asserted here by slicing performRebalanceInner and comparing string
 * indices, because the logic lived in the UI. It is `Orchestrator.rebalance()`
 * now, and tests/orchestrator/rebalance.test.ts asserts the same things
 * BEHAVIOURALLY -- that the closed value is what gets redeployed, that a value
 * it cannot read reports `closed-only` and creates nothing, and that a first
 * open with no configured amount refuses rather than deploying the wallet.
 *
 * What stays here is the bot's half: it renders the outcome and does not
 * re-decide it.
 */
describe('the bot renders the rebalance, it does not decide it', () => {
  const fn = (() => {
    const from = bot.slice(bot.indexOf('private async performRebalanceInner'));
    const end = from.slice(1).search(/\n  (private|async|public)/);
    return from.slice(0, end + 1);
  })();

  it('asks the Orchestrator and switches on what came back', () => {
    expect(fn).toMatch(/await this\.orchestrator\.rebalance\(\{/);
    expect(fn).toMatch(/switch \(outcome\.status\)/);
  });

  it('no longer resolves the budget itself', () => {
    expect(fn).not.toMatch(/getInvestmentAmount/);
    expect(fn).not.toMatch(/valueBeforeUsd/);
  });

  it('no longer checks the daily cap itself', () => {
    // The cap in two places double-counts; in neither there is no cap at all.
    expect(fn).not.toMatch(/hasExceededRebalanceLimit/);
  });

  it('treats closed-only differently from refused', () => {
    // closed-only means the position is GONE. Rendering it as "nothing
    // happened" would leave the bot watching something that does not exist.
    const closedOnly = fn.slice(fn.indexOf("case 'closed-only'"), fn.indexOf("case 'failed'"));
    expect(closedOnly).toMatch(/setActiveMint\(null\)/);
    expect(closedOnly).toMatch(/recordMonitoringIntent\(false\)/);

    const refused = fn.slice(fn.indexOf("case 'refused'"), fn.indexOf("case 'closed-only'"));
    expect(refused).not.toMatch(/setActiveMint/);
  });
});
