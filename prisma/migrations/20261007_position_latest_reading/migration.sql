-- The latest reading of an OPEN position, overwritten every monitor tick.
--
-- Additive and fully nullable: every existing row stays valid and reads NULL,
-- which the dashboard renders as "unknown" rather than as zero. Nothing
-- backfills, because there is no historical reading to backfill WITH -- these
-- values were computed every 30 seconds and discarded.
--
-- One row per position, overwritten in place. This is NOT the observations
-- series C2 removed: it has no history and no P&L figure reads it.
ALTER TABLE "positions" ADD COLUMN "last_read_at" TIMESTAMP(3);
ALTER TABLE "positions" ADD COLUMN "last_price" DOUBLE PRECISION;
ALTER TABLE "positions" ADD COLUMN "last_sol_amount" DOUBLE PRECISION;
ALTER TABLE "positions" ADD COLUMN "last_usdc_amount" DOUBLE PRECISION;
ALTER TABLE "positions" ADD COLUMN "last_fees_usd" DOUBLE PRECISION;
ALTER TABLE "positions" ADD COLUMN "last_in_range" BOOLEAN;
