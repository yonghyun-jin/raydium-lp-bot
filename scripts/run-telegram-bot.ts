#!/usr/bin/env npx ts-node

/**
 * Run the LP Auto Strategy Telegram Bot
 *
 * Usage:
 *   npx ts-node scripts/run-telegram-bot.ts
 *
 * Required environment variables:
 *   TELEGRAM_BOT_TOKEN - Your Telegram bot token from @BotFather
 *   POOL_ID - Raydium CLMM pool ID
 */

import dotenv from 'dotenv';
import { LPBot } from '../src/telegram';
import { SAFETY } from '../src/raydium/config';

dotenv.config();

async function main() {
  const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const POOL_ID = process.env.POOL_ID;

  if (!TOKEN) {
    console.error('Error: TELEGRAM_BOT_TOKEN not set in .env');
    console.error('Get a token from @BotFather on Telegram');
    process.exit(1);
  }

  if (!POOL_ID) {
    console.warn('Warning: POOL_ID not set in .env');
    console.warn('Using default SOL-USDC pool');
  }
  console.log('='.repeat(50));
  console.log('LP Auto Strategy - Telegram Bot');
  console.log('='.repeat(50));
  console.log('');
  console.log('Configuration:');
  console.log(`  Pool ID: ${POOL_ID || '(not set)'}`);
  console.log(`  Monitor Interval: 30s`);
  console.log(`  Min Duration: 6h`);
  console.log(`  Target Duration: 24h`);
  console.log(`  Failure Limit: 3/day`);
  console.log('');

  // Safety posture, stated plainly at boot.
  //
  // These are the switches that decide whether this process can spend, and
  // their values were previously invisible: Railway's API redacts variable
  // values, so "is the deployed bot armed?" could only be answered by
  // attempting a position and reading the guard's refusal. None of these are
  // secrets -- they are policy flags -- so print them.
  const canSpend = SAFETY.ALLOW_REAL_MONEY && !SAFETY.DRY_RUN;
  console.log('Safety:');
  console.log(`  ALLOW_REAL_MONEY: ${SAFETY.ALLOW_REAL_MONEY}`);
  console.log(`  DRY_RUN:          ${SAFETY.DRY_RUN}`);
  console.log(`  MAX_POSITION_USD: $${SAFETY.MAX_POSITION_USD.toFixed(2)}`);
  console.log(
    `  => ${
      canSpend
        ? 'ARMED - this bot CAN send real transactions'
        : SAFETY.DRY_RUN
          ? 'SAFE - DRY_RUN is set, transactions are simulated and never sent'
          : 'SAFE - ALLOW_REAL_MONEY is not set, every send is refused'
    }`
  );
  console.log('');

  const bot = new LPBot({
    token: TOKEN,
    ...(POOL_ID && { poolId: POOL_ID }),
  });

  await bot.launch();


  console.log('');
  console.log('Bot is running! Send /start to your bot on Telegram.');
  console.log('Press Ctrl+C to stop.');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
