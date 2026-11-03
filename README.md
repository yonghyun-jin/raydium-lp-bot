# LP Bot v0

A bot that provides liquidity to a Raydium CLMM SOL-USDC pool and keeps the position in range. You control it from Telegram.

**This is v0.** It always opens on a fixed range: the live price, −4% to +4%. The version running on the live dashboard is newer: it picks the range with a model and gets regular updates. v0 does not include those.

> **Read this first.** This bot signs real transactions with your wallet. Providing liquidity can lose money: impermanent loss, swap costs and network fees can exceed the fees you earn. Nothing here is a promise of returns. Use a fresh wallet that holds only what you are willing to lose, and start small.

## Real results

The model version ran on real money from Sept 21 to Oct 20, 2026, across 11 positions. Fees earned were $166.32 and impermanent loss was $348.41. Net it lost 5.74%, while just holding SOL lost 9.89%. These numbers come from the model version, not v0.

Every position broken down into fees, impermanent loss, market move and costs, plus a step-by-step setup guide: [papyruslearn.com/strategy/lp-strategy](https://www.papyruslearn.com/strategy/lp-strategy?utm_source=github&utm_medium=readme&utm_campaign=lp-breakdown-nov&utm_content=lp-bot-v0) (free, Google sign-in).

## What you need

| | What | Cost |
|---|---|---|
| 1 | A **new Solana wallet** used only for this bot | free |
| 2 | **SOL and/or USDC** in it, plus about 0.1 SOL for fees and rent | your capital |
| 3 | A **Solana RPC URL**, e.g. [Helius](https://helius.dev) (free tier works to start) | free |
| 4 | A **Telegram bot token** from [@BotFather](https://t.me/BotFather), and your Telegram user id | free |
| 5 | A **PostgreSQL database** (Railway, Supabase, Neon, or local) | free tier |
| 6 | Somewhere to run it 24/7: **Railway**, a VPS, or your own machine | ~$5/month |
| 7 | **Node.js 20+** if you run it locally | free |

## Setup

### 1. Install

```bash
npm install
npx prisma generate
```

### 2. Configure

```bash
cp .env.example .env
```

Fill in `.env`:

- `SOLANA_RPC_URL`: your mainnet RPC URL
- `WALLET_PRIVATE_KEY`: the base58 private key of the **new** bot wallet (Phantom: Settings → Security → Export Private Key)
- `POOL_ID`: a SOL-USDC **CLMM** pool, e.g. `3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv`
- `DATABASE_URL`: your Postgres connection string
- `TELEGRAM_BOT_TOKEN`: from @BotFather
- `TELEGRAM_ALLOWED_USER_IDS`: your Telegram user id. If you don't know it, start the bot and message it: the refusal tells you your id.

Leave `ALLOW_REAL_MONEY=false`, `DRY_RUN=true` and `MAX_POSITION_USD=25` for now.

**Never commit `.env`, never paste your private key into a chat or a screenshot, and never share it with anyone, including us.**

### 3. Create the database tables

```bash
npx prisma migrate deploy
```

### 4. Rehearse (spends nothing)

```bash
npm run rehearse:open -- 10
```

This builds a real $10 position transaction and simulates it against the live pool, without sending it. Do not continue until it passes.

### 5. Run

```bash
npm run telegram
```

Open your bot in Telegram and send `/start`. It asks for an amount, then asks you to type it back with `/confirm <amount>` before it spends anything.

When you are ready to go live, set `ALLOW_REAL_MONEY=true` and `DRY_RUN=false`. Keep `MAX_POSITION_USD` low for the first few positions.

### Deploying to Railway

`railway.toml` and `Dockerfile` are included. Add a PostgreSQL service, set the same variables as in `.env` in the Railway dashboard, and deploy. Migrations run automatically before each deploy.

### Dashboard (optional)

`dashboard/` is a read-only web page over the same database: every operation, its fees, costs, impermanent loss, and how it compares with simply holding. It is a separate service with its own password. See `dashboard/README.md`.

## Telegram commands

| Command | What it does |
|---|---|
| `/start` | Set an amount and start, or resume watching an open position |
| `/confirm <amount>` | Open the position (the amount must match) |
| `/status` | Position, range, and whether it is in range |
| `/balance` | Wallet balance |
| `/approve` / `/wait` | Answer when the price leaves the range: rebalance now, or keep the position |
| `/rebalance` | Close and reopen around the current price |
| `/close` | Close the position and keep the funds in the wallet |
| `/stop` | Stop watching (the position stays open) |
| `/resume` | Resume after the daily rebalance limit |
| `/cancel` | Cancel a pending amount |

## How v0 works

1. Reads the live pool price.
2. Sets the range to price −4% .. +4%.
3. Swaps once to the SOL/USDC ratio that range needs (CLMM maths, not 50/50).
4. Opens the position, using Jito bundles for MEV protection.
5. Checks every 30 seconds. When the price leaves the range:
   - position open **24h or more**: it rebalances on its own and tells you;
   - position open **less than 24h**: it asks you on Telegram (`/approve` or `/wait`).

   A daily cap (3) limits how many rebalances can happen. These timings are in `src/telegram/types.ts`.

To change the width, edit `V0_HALF_WIDTH_PCT` in `src/orchestrator/prediction.ts`.

## Safety switches

- Nothing is sent unless `ALLOW_REAL_MONEY=true`.
- `DRY_RUN=true` simulates every transaction and sends none.
- `MAX_POSITION_USD` caps any single position or swap.
- Only Telegram users listed in `TELEGRAM_ALLOWED_USER_IDS` can control the bot.

## Help

Questions while setting up? Ask in the Telegram group: https://t.me/+4KMyOPFEGlJjMTVh
