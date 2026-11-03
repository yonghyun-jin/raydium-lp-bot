-- Desired state, a stranded budget, and the tip the ladder learned.
--
-- WHY THIS EXISTS. On 2026-09-25 a rebalance closed a $1031.18 position and then
-- failed to reopen it. The monitoring loop's first line is
-- `if (!nftMint) return;` -- it watches a POSITION, and has no way to express "I
-- should have one and do not" -- so it did nothing every 30s while the money sat
-- in the wallet. Fixing the two causes of that particular failure does not close
-- the hole: any future exception between the close and the open strands the funds
-- the same way. What closes it is comparing DESIRED state to ACTUAL state, which
-- requires the desired state to be written down.
--
-- Additive and nullable/defaulted throughout, so the OLD container keeps working
-- against the new schema -- which Railway requires, since preDeployCommand runs
-- migrations before the new image takes traffic.

-- IDLE | DEPLOYED. Deliberately NOT is_monitoring, which conflates "the operator
-- wants the bot running" with "a position exists to watch". Those came apart
-- exactly when it mattered: monitoring was on and there was nothing to monitor.
ALTER TABLE "bot_states" ADD COLUMN "deploy_intent" TEXT NOT NULL DEFAULT 'IDLE';

-- What the failed reopen was supposed to deploy, in USD.
--
-- MUST be persisted rather than recomputed. Recovery runs as a separate
-- invocation, by which time the position it came from is burned, so
-- resolveOpenPosition finds nothing and the budget falls back to the configured
-- INVESTMENT_AMOUNT. That really happened: the retry read
-- `Budget $1000.00` instead of the $1031.18 actually withdrawn, silently leaving
-- $31 behind -- and it would do so on every attempt.
ALTER TABLE "bot_states" ADD COLUMN "stranded_usd" DOUBLE PRECISION;
ALTER TABLE "bot_states" ADD COLUMN "stranded_since" TIMESTAMP(3);

-- Recovery's own budget, SEPARATE from rebalances_today.
--
-- rebalances_today is incremented BEFORE any work and hasExceededRebalanceLimit
-- fails closed against failureLimitPerDay = 3, so three failures lock the bot out
-- for the rest of the day. That cap exists to stop churn; reusing it for recovery
-- would make the guard against churn also the guard against getting the money
-- back, which is backwards.
ALTER TABLE "bot_states" ADD COLUMN "recovery_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "bot_states" ADD COLUMN "last_recovery_at" TIMESTAMP(3);

-- The tip that last landed, in lamports, so the ladder starts where it left off.
--
-- Without this the ladder re-derives its starting point every process and the
-- convergence on the smallest viable tip cannot compound past a redeploy, which
-- on Railway is often. Nullable: null is a cold start, which bids from the
-- configured floor -- already an order of magnitude above the median.
ALTER TABLE "bot_states" ADD COLUMN "last_tip_lamports" INTEGER;
