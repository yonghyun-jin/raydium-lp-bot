-- Telegram ids do not fit in INT4.
--
-- telegram_user_id / telegram_chat_id were INTEGER (max 2,147,483,647) while a
-- real Telegram user id is ~7.7 billion. Postgres rejects the insert with
-- "Unable to fit integer value into an INT4", so bot_states was unusable for
-- any actual user -- latent only because nothing ever wrote to the table.
--
-- Widening INTEGER -> BIGINT is lossless and the table is empty, so this
-- rewrites nothing.
ALTER TABLE "bot_states" ALTER COLUMN "telegram_user_id" SET DATA TYPE BIGINT;
ALTER TABLE "bot_states" ALTER COLUMN "telegram_chat_id" SET DATA TYPE BIGINT;
