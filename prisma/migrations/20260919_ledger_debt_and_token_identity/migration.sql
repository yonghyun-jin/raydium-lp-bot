-- Generalise the ledger for lending, other chains, and other coin pairs.
-- Design: docs/v1-confidential/ledger-schema.md
--
-- ADDITIVE ONLY: two nullable columns and an index. The table is empty and has
-- no importers, so nothing is rewritten and no code breaks. Doing this now is
-- the point -- once accounting rows exist, changing their shape means
-- retroactively rewriting financial history, which is the migration nobody
-- wants to run.
--
-- The `category` vocabulary also widens (principal | reward | fee | interest |
-- debt | slippage | gas | cost) but needs no DDL: the column is already TEXT.
-- `debt` is the one that changes P&L CORRECTNESS -- a borrow is recorded as a
-- principal row plus an opposing debt row, and profit queries must exclude
-- category = 'debt' or borrowed money reads as income.

-- Token IDENTITY, as opposed to its display label. Solana USDC, Ethereum USDC
-- and Arbitrum USDC share a symbol and are different assets; grouping by
-- `token` alone silently merges them once a second chain exists.
ALTER TABLE "ledger_entries" ADD COLUMN "token_address" TEXT;

-- Where price_usd came from. Irrelevant for SOL/USDC, load-bearing for a thin
-- pair where the entire P&L rests on that single number.
ALTER TABLE "ledger_entries" ADD COLUMN "price_source" TEXT;

-- The grouping key for any per-asset query that has to be correct across chains.
CREATE INDEX "ledger_entries_chain_token_address_idx" ON "ledger_entries"("chain", "token_address");
