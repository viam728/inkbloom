-- Migration 020: terms acceptance + deregistration cool-down (tech plan v2 §9.2)
-- users.agreed_terms_at: registration-time terms/privacy acceptance stamp.
-- users.status=2 (cool-down) already exists in the model enum; no schema
-- change needed for it beyond the column below.

ALTER TABLE users ADD COLUMN IF NOT EXISTS agreed_terms_at TIMESTAMPTZ NULL;
