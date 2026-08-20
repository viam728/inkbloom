-- Task #64 rollback: drop the AIGC history table.

DROP INDEX IF EXISTS idx_aigc_records_user_created;
DROP TABLE IF EXISTS aigc_records;
