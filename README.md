# LP Bot v0: Raydium SOL/USDC liquidity bot

A bot that provides liquidity to a Raydium CLMM SOL/USDC pool, keeps the position in range, and records every dollar it makes and loses — fees, impermanent loss, market move, all of it. You control it from Telegram.

👉 **Setup guide, latest updates, and live bot activity: [papyruslearn.com/strategy/lp-strategy](https://www.papyruslearn.com/strategy/lp-strategy)**

![The P&L dashboard: every fee, impermanent loss, market move and cost, against just holding](docs/images/dashboard-demo.gif)

<sub>The dashboard ships with v0. [Full-quality video](docs/dashboard-demo.mp4)</sub>

## v0 vs the latest version

| | v0 (this repo, free) | Latest version (Pro) |
|---|---|---|
| Price range | Fixed: −4% to +4% | Picked by a model from the 200 most similar past hours |
| Automation: swaps, rebalancing, safety limits | Included | Included |
| Telegram control | Included | Included |
| P&L dashboard | Included | Included |
| Updates | None | Every patch, as soon as it's ready |
| Where to get it | This repo | [papyruslearn.com/pro](https://www.papyruslearn.com/pro?utm_source=github&utm_medium=readme&utm_campaign=lp-breakdown-nov&utm_content=lp-bot-v0-compare) |

## Real results

See how the latest bot is doing, with every position broken down: **[papyruslearn.com/performance/lp-bot](https://www.papyruslearn.com/performance/lp-bot?utm_source=github&utm_medium=readme&utm_campaign=lp-breakdown-nov&utm_content=lp-bot-v0-results)** (free, Google sign-in)

## Setup guide & latest bot updates

👉 **[papyruslearn.com/strategy/lp-strategy](https://www.papyruslearn.com/strategy/lp-strategy)**

This is where the full setup walkthrough lives, along with every bot update and live position activity. Easier to follow than this README, and kept up to date with every patch.

---

> ## ⚠️ Read this first
>
> - **Providing liquidity can lose money.** Impermanent loss, swap costs and network fees can be bigger than the fees you earn. Nothing here is a promise of returns.
> - **Use a brand-new wallet** that holds only what you are willing to lose, and start small.

---

## The easy way: set it up with Claude Code

If you have [Claude Code](https://claude.com/claude-code), open a terminal in this folder and run:

```bash
claude
```

Then type:

```
Set up this bot for me. Follow CLAUDE.md.
```

Claude reads [`CLAUDE.md`](CLAUDE.md), installs everything, creates your `.env`, walks you through each value below, and runs the rehearsal that spends nothing.

**Claude will never ask for your private key.** You paste it into `.env` yourself. If anything, including Claude, asks you to paste a private key into a chat, stop.

---

## What you need

| | What | Cost | Time |
|---|---|---|---|
| 1 | A **new Solana wallet**, used only for this bot | free | 2 min |
| 2 | **SOL and/or USDC** in it, plus about **0.1 SOL** for fees and rent | your capital | |
| 3 | A **Solana RPC URL**: the public one to start, a free Helius one before real money | free | 0–3 min |
| 4 | A **Telegram bot token** and your **Telegram user id** | free | 3 min |
| 5 | A **PostgreSQL database** (Railway, Supabase, Neon, or local) | free tier | 5 min |
| 6 | Somewhere to run it 24/7: **Railway**, a VPS, or your own machine | ~$5/month | 10 min |
| 7 | **Node.js 20+** if you run it on your own machine | free | |

---

## Your private key: what it is and how to keep it safe

Your private key is the one secret that controls your wallet. **Anyone who has it can move every coin in that wallet, instantly and permanently.** There is no "undo", no support line, and no way to get the funds back.

The bot needs it because it has to sign transactions (swaps, opening and closing positions) without you clicking "approve" each time.

**What can go wrong, and how to avoid it:**

| Risk | How it happens | What to do |
|---|---|---|
| Someone gets your key | You paste it into a chat, a Discord DM, a screenshot, or a website | Only ever put it in `.env` (or your host's secret variables). Nowhere else |
| It ends up on GitHub | You commit `.env` by accident | `.env` is already in `.gitignore`. Never remove that line. Check `git status` before every commit |
| Your server is hacked | The key sits in plain text on the machine running the bot | Use a host you trust, keep the machine updated, and keep only bot funds in the wallet |
| You lose your main savings | You used your main wallet | **Always create a brand-new wallet just for this bot.** Never use your main one |
| A "support agent" asks for it | Scammers pretend to be admins or developers | Nobody legitimate will ever ask for your private key. Not us, not Raydium, not Phantom |

---

## Setup, step by step

### 1. Install

```bash
npm install
npx prisma generate
```

### 2. Create your `.env`

```bash
cp .env.example .env
```

Then fill in each value below. `.env.example` has comments for every line.

#### `WALLET_PRIVATE_KEY`: your new bot wallet

1. Open **[Phantom](https://phantom.com/download)** (browser extension or phone app). Don't have it? Install it from that link, the official site. Fake Phantom extensions exist, so don't install it from a search ad.
2. Create a **new account**. In Phantom: tap your account name at the top → **Add / Connect Wallet** → **Create New Account**. Name it something like "LP bot".
   - Use a recovery-phrase wallet. A wallet you signed into **with Google or Apple can't export a private key**, so it won't work for the bot.
3. Send it the SOL/USDC you want to use, plus about 0.1 SOL for fees.
4. Export its key. In Phantom: click your avatar → **Settings** (gear icon) → **Manage Accounts** → pick the new account (on the phone app, tap the **⋯** next to it) → **Show Private Key** → choose **Solana** → enter your password. Phantom's own guide, with pictures: [View your recovery phrase or private keys in Phantom](https://help.phantom.com/hc/en-us/articles/25334064171795-View-your-recovery-phrase-or-private-keys-in-Phantom).
5. Copy the long string (it starts with a number or letter, about 88 characters) and paste it after `WALLET_PRIVATE_KEY=` in `.env`.

Read the private key section above before you do this.

#### `SOLANA_RPC_URL`: how the bot talks to Solana

This must be a **mainnet** URL. `.env.example` starts on devnet, where the SOL/USDC pool doesn't exist, so change it.

**To start, no sign-up:** use Solana's free public URL.

```
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
```

**Before you put real money in:** switch to a free [Helius](https://helius.dev) URL. The public one is rate-limited, and a rejected request in the middle of a rebalance can slow the bot down when it matters. Sign up, open **Endpoints** (or **RPCs**) in the dashboard, copy the **Mainnet** URL (`https://mainnet.helius-rpc.com/?api-key=...`) and paste it after `SOLANA_RPC_URL=`.

#### `POOL_ID`: which pool to provide liquidity to

Use the main SOL/USDC CLMM pool (0.04% fee):

```
POOL_ID=3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv
```

It must be a **CLMM** pool. `.env.example` lists two other SOL/USDC CLMM pools.

#### `TELEGRAM_BOT_TOKEN`: your own Telegram bot

1. In Telegram, open [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Pick a name and a username ending in `bot`.
3. BotFather replies with a token like `1234567890:AAH...`. Paste it after `TELEGRAM_BOT_TOKEN=`.

Treat this token like a password: whoever has it controls your bot.

#### `TELEGRAM_ALLOWED_USER_IDS`: who may control the bot

This is your numeric Telegram user id, not your @username. Two ways to find it:

- Message [@userinfobot](https://t.me/userinfobot) in Telegram. It replies with your id.
- Or leave this empty, start the bot (step 5), and message it. It refuses you and tells you your id.

Only ids listed here can control the bot. If it's empty, the bot refuses everyone.

#### `DATABASE_URL`: where the bot keeps its records

Any PostgreSQL works. Pick one:

- **Railway** (easiest if you deploy there): add a PostgreSQL service and Railway fills this in for you.
- **Supabase** or **Neon**: create a free project and copy the connection string (Supabase: **Project Settings → Database → Connection string → URI**).
- **Local**, with Docker:

  ```bash
  docker run -d --name lp-db -e POSTGRES_PASSWORD=lpbot -p 5432:5432 postgres:16
  ```

  Then `DATABASE_URL=postgresql://postgres:lpbot@localhost:5432/postgres`

#### Leave these as they are for now

```
ALLOW_REAL_MONEY=false
DRY_RUN=true
MAX_POSITION_USD=25
```

These keep the bot from spending anything until you've rehearsed.

### 3. Create the database tables

```bash
npx prisma migrate deploy
```

### 4. Rehearse (spends nothing)

```bash
npm run rehearse:open -- 10
```

This builds a real $10 position transaction and simulates it against the live pool, without sending it. **Do not continue until it passes.**

### 5. Run

```bash
npm run telegram
```

Open your bot in Telegram and send `/start`. It asks for an amount, then asks you to type it back with `/confirm <amount>` before it spends anything.

![Telegram /status: in range or not, fees earned, and where your money is](docs/images/telegram-status.png)

### 6. Go live

When the rehearsal passes and you're ready:

```
ALLOW_REAL_MONEY=true
DRY_RUN=false
```

Keep `MAX_POSITION_USD` low for your first few positions, and raise it only after you've watched the bot run.

### Deploying to Railway

`railway.toml` and `Dockerfile` are included. Add a PostgreSQL service, set the same variables as in `.env` in the Railway dashboard, and deploy. Migrations run automatically before each deploy.

### Dashboard (optional)

`dashboard/` is a read-only web page over the same database: every operation, its fees, costs and impermanent loss, and how it compares with just holding. It is a separate service with its own password. See [`dashboard/README.md`](dashboard/README.md).

![Every closed position, split into fees, market move, impermanent loss, trading costs and rent](docs/images/pnl-breakdown.png)

![One position, line by line](docs/images/operation-breakdown.png)

---

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

- Stuck on setup? Ask in the Telegram group: https://t.me/+4KMyOPFEGlJjMTVh
- Want the latest version with every patch? [papyruslearn.com/pro](https://www.papyruslearn.com/pro?utm_source=github&utm_medium=readme&utm_campaign=lp-breakdown-nov&utm_content=lp-bot-v0-help)

## License

[MIT](LICENSE)
