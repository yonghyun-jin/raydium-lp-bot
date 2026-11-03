# Setting up LP Bot v0 (instructions for Claude Code)

The user wants this bot running. Walk them through it one step at a time, in plain language. Assume they are not a developer. README.md has the details for every step; this file is the order and the rules.

## Hard rules

- **Never ask for, read, print, or echo `WALLET_PRIVATE_KEY`.** Not in chat, not with `cat .env`, not in a command. Tell the user to open `.env` in a text editor and paste it themselves. To check it is set, use `grep -c '^WALLET_PRIVATE_KEY=.\+' .env` (prints 1 or 0), never the value.
- Treat `TELEGRAM_BOT_TOKEN` and `DATABASE_URL` the same way: the user pastes them into `.env`. Do not print them back.
- If the user pastes a private key into the chat anyway, tell them it is now exposed and they should move the funds to a new wallet and use that wallet's key instead.
- Never set `ALLOW_REAL_MONEY=true` or `DRY_RUN=false` yourself. The user does that, after the rehearsal passes, once they say they are ready.
- Never commit `.env` and never remove it from `.gitignore`.
- Before the user funds the wallet, make sure they understand: providing liquidity can lose money, and the wallet should be a brand-new one holding only what they are willing to lose.

## Steps

1. **Check Node.js.** `node -v` must be 20 or higher. If not, tell them how to install it (https://nodejs.org, or `brew install node` on a Mac).
2. **Install.** `npm install` then `npx prisma generate`.
3. **Create `.env`.** `cp .env.example .env` (skip if `.env` already exists).
4. **Fill in `.env`, one value at a time.** For each, explain what it is and where to get it, using the matching section of README.md ("Create your `.env`"). Order:
   1. `WALLET_PRIVATE_KEY`: a brand-new wallet. Read them the private key risks from README.md first.
   2. `SOLANA_RPC_URL`: Helius free tier.
   3. `POOL_ID`: suggest `3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv`. You may write this one into `.env` yourself.
   4. `TELEGRAM_BOT_TOKEN`: from @BotFather.
   5. `TELEGRAM_ALLOWED_USER_IDS`: from @userinfobot, or from the bot's refusal message later.
   6. `DATABASE_URL`: ask where they will run it (their machine, Railway, Supabase/Neon). For local, offer the Docker command in README.md if Docker is installed.

   Keep `ALLOW_REAL_MONEY=false`, `DRY_RUN=true`, `MAX_POSITION_USD=25`.
5. **Check every value is set** without printing any: `grep -cE '^(WALLET_PRIVATE_KEY|SOLANA_RPC_URL|POOL_ID|TELEGRAM_BOT_TOKEN|TELEGRAM_ALLOWED_USER_IDS|DATABASE_URL)=.+' .env` should print 6.
6. **Create the tables.** `npx prisma migrate deploy`.
7. **Run the tests** (optional, about a minute): `npx jest`. They never touch the network or money.
8. **Rehearse.** `npm run rehearse:open -- 10`. It simulates a $10 position and sends nothing. If it fails, read the error with the user and fix the cause (usually the RPC URL, the pool id, or an empty wallet) before going on.
9. **Start the bot.** `npm run telegram`, then have them send `/start` to their bot in Telegram.
10. **Going live** is the user's decision. When they ask, explain what `ALLOW_REAL_MONEY=true` and `DRY_RUN=false` do, suggest keeping `MAX_POSITION_USD` small, and let them edit `.env`.

For running it 24/7 on Railway, follow "Deploying to Railway" in README.md. For the P&L dashboard, follow `dashboard/README.md`.

## When something breaks

- `TELEGRAM_ALLOWED_USER_IDS is not set`: the user has not filled it in. The bot's refusal message shows their id.
- Rehearsal fails with an RPC error: check `SOLANA_RPC_URL` is a **mainnet** URL.
- Pool errors: `POOL_ID` must be a Raydium **CLMM** pool (program `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK`).
- Setup help from people: https://t.me/+4KMyOPFEGlJjMTVh
