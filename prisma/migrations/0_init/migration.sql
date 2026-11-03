-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL,
    "tx_id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "chain" TEXT NOT NULL DEFAULT 'solana',
    "protocol" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "price_usd" DOUBLE PRECISION NOT NULL,
    "value_usd" DOUBLE PRECISION NOT NULL,
    "position_id" TEXT,
    "description" TEXT,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bot_states" (
    "id" TEXT NOT NULL,
    "telegram_user_id" INTEGER NOT NULL,
    "telegram_chat_id" INTEGER NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'IDLE',
    "is_monitoring" BOOLEAN NOT NULL DEFAULT false,
    "investment_amount" DOUBLE PRECISION,
    "sol_amount" DOUBLE PRECISION,
    "usdc_amount" DOUBLE PRECISION,
    "position_nft_mint" TEXT,
    "rebalances_today" INTEGER NOT NULL DEFAULT 0,
    "last_rebalance_date" TEXT,
    "started_at" TIMESTAMP(3),
    "last_notification" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bot_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" TEXT NOT NULL,
    "nft_mint" TEXT NOT NULL,
    "pool_id" TEXT NOT NULL,
    "range_lower" DOUBLE PRECISION NOT NULL,
    "range_upper" DOUBLE PRECISION NOT NULL,
    "sol_deposited" DOUBLE PRECISION NOT NULL,
    "usdc_deposited" DOUBLE PRECISION NOT NULL,
    "is_open" BOOLEAN NOT NULL DEFAULT true,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),
    "sol_withdrawn" DOUBLE PRECISION,
    "usdc_withdrawn" DOUBLE PRECISION,
    "fees_earned_usd" DOUBLE PRECISION,
    "operation_id" TEXT,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ledger_entries_operation_id_idx" ON "ledger_entries"("operation_id");

-- CreateIndex
CREATE INDEX "ledger_entries_tx_id_idx" ON "ledger_entries"("tx_id");

-- CreateIndex
CREATE INDEX "ledger_entries_category_idx" ON "ledger_entries"("category");

-- CreateIndex
CREATE INDEX "ledger_entries_timestamp_idx" ON "ledger_entries"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "bot_states_telegram_user_id_key" ON "bot_states"("telegram_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "positions_nft_mint_key" ON "positions"("nft_mint");

-- CreateIndex
CREATE INDEX "positions_pool_id_idx" ON "positions"("pool_id");

-- CreateIndex
CREATE INDEX "positions_is_open_idx" ON "positions"("is_open");

