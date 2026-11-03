-- v0 -> v1, step 1 of the plan in docs/v1/database-schema.md.
--
-- ADDITIVE ONLY. Every change is a new table, a new nullable column, or the
-- RELAXING of a constraint. Nothing is dropped, narrowed or backfilled, so this
-- cannot fail on existing data -- which matters because railway.toml runs
-- `prisma migrate deploy` as preDeployCommand: a failed migration means the
-- container never starts. Schema therefore ships in its own release, BEFORE the
-- code that reads these columns.
--
-- All three tables are currently empty (src/db has zero importers), so the
-- opened_at relaxation below rewrites no rows.

-- positions.opened_at becomes NULLABLE.
--
-- A position adopted via /done was not created by this bot and its true open
-- time is NOT recoverable from the chain -- position age is not stored on-chain.
-- Writing Date.now() there, as the current code does, silently converts
-- "unknown" into "brand new" and routes a mature position into the under-6h
-- Early Exit branch. Unknown has to survive as unknown so the age reader can ask
-- instead of assume.
ALTER TABLE "positions" ALTER COLUMN "opened_at" DROP NOT NULL;
ALTER TABLE "positions" ALTER COLUMN "opened_at" DROP DEFAULT;

-- When this bot took over a position it did not create. Distinct from
-- opened_at: adopting at 14:00 says nothing about when the position began.
ALTER TABLE "positions" ADD COLUMN "adopted_at" TIMESTAMP(3);

-- The position this one replaced. A rebalance closes one and opens another;
-- without the link the chain of rebalances, and "how long did this capital stay
-- deployed" across them, is unrecoverable.
ALTER TABLE "positions" ADD COLUMN "prev_position_id" TEXT;

CREATE INDEX "positions_prev_position_id_idx" ON "positions"("prev_position_id");

-- What the model said, and when. Nothing recorded this before, so every range
-- the bot has produced is gone. features/neighbor_stats are kept alongside the
-- outcome because without them a bad range cannot be told from bad luck.
CREATE TABLE "predictions" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pool_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "anchor_price" DOUBLE PRECISION NOT NULL,
    "price_lower" DOUBLE PRECISION NOT NULL,
    "price_upper" DOUBLE PRECISION NOT NULL,
    "width_pct" DOUBLE PRECISION NOT NULL,
    "sol_ratio" DOUBLE PRECISION NOT NULL,
    "features" JSONB,
    "neighbor_stats" JSONB,
    "position_id" TEXT,

    CONSTRAINT "predictions_pkey" PRIMARY KEY ("id")
);

-- Samples of a live position. Time-in-range is the `Duration` in
-- `Duration x (1/Width)` and is NOT derivable from opened_at/closed_at alone --
-- a position can drift out of range and back while still open.
--
-- `reason` separates the two write triggers ('transition' | 'heartbeat') so the
-- fee curve can be read apart from the range crossings without inferring which
-- is which.
CREATE TABLE "position_observations" (
    "id" TEXT NOT NULL,
    "position_id" TEXT NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "price" DOUBLE PRECISION NOT NULL,
    "in_range" BOOLEAN NOT NULL,
    "value_usd" DOUBLE PRECISION NOT NULL,
    "fees_earned_usd" DOUBLE PRECISION,
    "reason" TEXT NOT NULL DEFAULT 'heartbeat',

    CONSTRAINT "position_observations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "predictions_pool_id_created_at_idx" ON "predictions"("pool_id", "created_at");

CREATE INDEX "predictions_position_id_idx" ON "predictions"("position_id");

CREATE INDEX "position_observations_position_id_observed_at_idx" ON "position_observations"("position_id", "observed_at");

-- SET NULL, not CASCADE: a prediction is a record of what the model said and
-- stays true even if the position it fed is removed.
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RESTRICT: an observation without its position is meaningless, so deleting a
-- position with samples attached should fail loudly rather than orphan them.
ALTER TABLE "position_observations" ADD CONSTRAINT "position_observations_position_id_fkey" FOREIGN KEY ("position_id") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
