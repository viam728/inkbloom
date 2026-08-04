-- 001_init.down.sql
-- Drop tables in reverse order to respect foreign key constraints

DROP TABLE IF EXISTS characters;
DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS chapters;
DROP TABLE IF EXISTS volumes;
DROP TABLE IF EXISTS novels;
