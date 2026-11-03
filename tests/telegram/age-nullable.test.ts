/**
 * An unknown position age must reach the user, never an automatic branch.
 *
 * `checkPosition` auto-rebalances WITHOUT asking once a position passes 24h.
 * That age used to come from `.telegram-state.positionOpenedAt` with
 * `openedAt ? ... : 0`, and that file is not on the Railway volume -- so every
 * redeploy erased it and a mature position read as 0h. The live position was
 * 44h old and still being treated as brand new, which is why the auto branch
 * could never fire in production.
 *
 * Making ageHours nullable is what forces every consumer to decide. These tests
 * pin the two decisions that matter: the branch routes null to "ask", and the
 * user-facing text says "unknown" rather than re-inventing "0h".
 */

import * as fs from 'fs';
import * as path from 'path';

import { messages } from '../../src/telegram/messages';
import type { PositionStatus } from '../../src/telegram/types';

const base: PositionStatus = {
  inRange: false,
  currentPrice: 113.31,
  rangeLower: 96.88,
  rangeUpper: 104.38,
  feesEarned: 0.12,
  ageHours: 44,
  valueUsd: 3000,
  nftMint: 'Mint111',
};

describe('user-facing age rendering', () => {
  it('shows a real age when it is known', () => {
    expect(messages.positionStatus({ ...base, ageHours: 44.5 })).toMatch(/Age: 44h 30m/);
  });

  it('says "unknown" rather than 0h when the age is null', () => {
    // Coercing null to 0h would put the exact lie back into the text the
    // operator reads -- and it is the most convincing place for it, because a
    // freshly-opened position looks identical.
    const text = messages.positionStatus({ ...base, ageHours: null });
    expect(text).toMatch(/Age: unknown/);
    expect(text).not.toMatch(/Age: 0h/);
  });

  it('does the same in the out-of-range prompt', () => {
    // RangeSuggestion, not the old LLMRecommendation: no `strategy` verdict and
    // no `confidence` score -- both stated things the model does not know.
    const rec = {
      available: true,
      rangeLower: 106,
      rangeUpper: 120,
      widthPct: 12.5,
      solRatioPct: 48,
      reason: 'test',
    };
    expect(messages.outOfRange({ ...base, ageHours: null }, rec)).toMatch(/Age: unknown/);
    expect(messages.outOfRange({ ...base, ageHours: null }, rec)).not.toMatch(/Age: 0h/);
  });
});

describe('the monitoring branch', () => {
  const read = (rel: string) =>
    fs
      .readFileSync(path.join(__dirname, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  // B3 step 3 moved getPositionStatus into the Orchestrator, so the age read
  // moved with it. The property is unchanged and so is the assertion -- only
  // the file it points at.
  const source = read('../../src/orchestrator/Orchestrator.ts') + read('../../src/telegram/bot.ts');

  it('reads age from the database, not from .telegram-state', () => {
    expect(source).toMatch(/const ageHours = await getPositionAgeHours\(nftMint\)/);
    // The old coercion must be gone entirely.
    expect(source).not.toMatch(/positionOpenedAt.*\?.*Date\.now\(\).*:\s*0/);
  });

  it('checks for null BEFORE any age comparison', () => {
    const branch = source.slice(source.indexOf('const age = status.ageHours;'));
    const nullCheck = branch.indexOf('age === null');
    const firstCompare = branch.indexOf('age >= this.config.targetPositionDurationHours');
    expect(nullCheck).toBeGreaterThan(-1);
    expect(firstCompare).toBeGreaterThan(-1);
    expect(nullCheck).toBeLessThan(firstCompare);
  });

  it('routes an unknown age to the user, not to a rebalance', () => {
    // The choice used to be inline-keyboard buttons (`approve_rebalance`,
    // `close_position`); it is now slash commands carried by CHOICES.outOfRange.
    // The assertion is the same one either way: the branch OFFERS and never acts.
    const branch = source.slice(source.indexOf('age === null'));
    const body = branch.slice(0, branch.indexOf('if (age >='));
    expect(body).toMatch(/CHOICES\.outOfRange/);    // offered as a choice
    expect(body).not.toMatch(/performRebalance\(/); // never done automatically
  });
});
