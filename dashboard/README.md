# Dashboard

Read-only P&L over Postgres. It answers one question — *am I better off than if
I had done nothing?* — and it answers it from rows that were written when money
actually moved.

**It is read-only by decision, not by omission.** It queries Postgres directly,
never calls the Orchestrator, and has no chain access. Every operation, swap and
automation control stays in Telegram as a slash command.

---

## Why it is a separate package

`express` must not enter the bot's dependency tree, so the dashboard has its own
package and its own lockfile.

It also runs as its own Railway service, which is what lets the bot stay a
portless long-polling worker — `railway.toml` says it never binds a port, and
that stays true.

Two things are shared with the repo root, both deliberately:

| | Why |
|---|---|
| `prisma/schema.prisma` | One authored schema. `npm run db:generate` copies it into `dashboard/prisma/` (gitignored) only because `prisma generate` resolves `@prisma/client` relative to the schema's own directory |
| `src/pnl/` | One definition of what P&L means. Pure functions, no database and no dependencies, covered by the root `npm test` |

## Running it locally

```bash
cd dashboard
npm install
npm run db:generate          # regenerates dashboard/prisma/ + the client

# terminal 1 — API on :3000
DATABASE_URL=...  DASHBOARD_PASSWORD=<16+ chars>  npm run dev:server

# terminal 2 — Vite dev server, proxying /api to :3000
npm run dev
```

If you move the API off 3000, give Vite the same number — `PORT=4173 npm run
dev:server` in one terminal needs `API_PORT=4173 npm run dev` in the other.
Otherwise the proxy points at nothing, and a 502 with an empty body reads on the
page as a ledger that could not be read.

For a production-shaped check, `npm run build` then `npm start` serves the built
bundle and the API from one process on `PORT` (default 3000).

`DATABASE_URL` can point at the Railway Postgres through its TCP proxy.

## Deploying

A second service in the same Railway project:

1. **New service → same repo.** Set **Dockerfile Path** to `dashboard/Dockerfile`
   and leave the root directory at `/` — the build context must be the repo root,
   because the image needs `prisma/` and `src/pnl/` from outside this folder.
2. **Variables:**
   - `DATABASE_URL` — reference the Postgres service. Use a **read-only role**
     (below), not the bot's credentials.
   - `DASHBOARD_PASSWORD` — 16+ characters. The service refuses to start without
     one.
   - `DASHBOARD_USER` — optional, defaults to `operator`.
   - `PNL_EXCLUDE_OPERATIONS` — optional, see below.
3. **Generate the domain last**, after the password is set.

Do **not** add `preDeployCommand` here. Migrations belong to the bot's service;
two services racing `prisma migrate deploy` is a way to fail a deploy for no
reason.

### The read-only role

The code only ever `SELECT`s, but the guarantee belongs in the grant:

```sql
CREATE ROLE dashboard LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE railway TO dashboard;
GRANT USAGE ON SCHEMA public TO dashboard;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO dashboard;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO dashboard;
```

## Setting an operation aside

Some cycles are not the strategy — a test run, a deliberate experiment. List
their operation ids to keep them out of the headline and the chart:

```
PNL_EXCLUDE_OPERATIONS=op_<id>,op_<id>
```

Three things this deliberately is **not**:

- **It does not delete anything.** The rows stay exactly as written — the money
  really did move. A P&L you can edit by deleting rows is not an accounting
  record, and the ledger is the one artefact in this project that has to stay
  literally true.
- **It does not hide the operation.** It stays in the ledger table, marked
  `Test run`, with its real figures intact — a status that says a human set it
  aside, not that the data could not support it.
- **It is not a database flag.** The dashboard is read-only, and adding a write
  path so it could hide a number would be the first crack in that. This is a
  judgement about presentation, so it lives in config where it is visible in the
  Railway variables and reversible by editing one line.

If a set-aside operation is *also* still open, the status reads `Test run` —
the more specific answer, and the one that records a decision was made.

## What the page is

A ledger. One row per operation -- opened, closed, status, LP range, capital in,
net -- expanding to the SOL price at each end, the fee and rent split, and every
transaction with every movement inside it. Transaction ids link to Solscan.

Below it, the "against simply holding" chart: the same tokens revalued at each
operation's closing price and never deployed. Settled operations only.

`src/pnl/ledger.ts` builds the tree and **branches on no action name** -- the
ledger schema is protocol-agnostic on purpose, so a lending or staking operation
renders here with no code change. If you are adding a category, add it to
`KIND_BY_CATEGORY` in that file; an unrecognised one shows as a plain movement
rather than being guessed into the cost column.

## What it cannot show, deliberately

- **A live position's value or accrued fees.** Nothing is written while a
  position is open and this service has no chain access. Telegram `/status`
  reads the chain on demand and already renders it. Do not resolve the blank
  view by adding a timer write or a chain reader here.
- **Time-in-range.** Nothing records it yet.
- **Jito tips.** The tip is a separate transaction inside the bundle and the
  ledger only reads the main signature's effects, so every figure is slightly
  better than reality. The page says so.
