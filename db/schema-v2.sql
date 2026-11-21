-- ============================================================================
-- Temp Mail v2 -- D1 Schema (fresh install)
-- ============================================================================
-- Use this file to create a brand-new v2 database from scratch.
-- To upgrade an existing v1 database in place, use migrate-v1-to-v2.sql
-- instead -- do NOT re-run this file against a v1 database.
--
-- Design contract: docs/ARCHITECTURE.md section 6 (D1 query and index plan).
-- Base tables, AUTOINCREMENT ids, token model, and column names are unchanged
-- from v1 (db-schema-v1.sql) so the v1 Worker remains able to read a v2
-- database (rollback safety, ARCHITECTURE.md section 7.5). Everything v2
-- adds is either a nullable column or a new index.
--
-- What changed vs v1, in summary:
--   1. mails gains two nullable columns, preview and otp, computed once at
--      ingest instead of being re-derived on every read (sections 6.1/6.3).
--   2. The two single-column mails indexes from v1 are replaced by two
--      composite indexes that also cover the ORDER BY id sorts and the
--      hourly cron expiry scan (section 6.1).
--   3. The addresses indexes are kept exactly as in v1 (see below).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Table: addresses
-- ----------------------------------------------------------------------------
-- Unchanged from v1. One row per disposable inbox.
--   address    -- full address, e.g. test123@turjaun.xyz. UNIQUE, so SQLite
--                 already maintains an index for it (see note on
--                 idx_addresses_address below).
--   token      -- per-inbox Bearer token returned by POST /api/new_address.
--   expires_at -- unixepoch seconds when the inbox expires (24h TTL);
--                 NULL means "no recorded expiry" (rows auto-created by the
--                 email() catch-all handler in v1 had no expiry set).
CREATE TABLE IF NOT EXISTS addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT UNIQUE NOT NULL,
  token TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER
);

-- ----------------------------------------------------------------------------
-- Table: mails
-- ----------------------------------------------------------------------------
-- One row per received message.
--   preview -- NEW IN v2. First ~200 characters of text_body, computed once
--              at ingest (by whichever MIME parser ran: Rust WASM or the JS
--              fallback). List / delta / wait responses select this column
--              instead of shipping text_body/html_body and truncating on the
--              client (ARCHITECTURE.md sections 1.3, 3.3, 6.3). Nullable:
--              rows written before this column existed have NULL here, and
--              reads must fall back with
--              COALESCE(preview, substr(text_body, 1, 200)).
--   otp     -- NEW IN v2. The first 4-8 digit code found in subject+text,
--              extracted once at ingest. In v1 every list read re-ran a
--              regex over the full body of every row; storing it removes
--              that per-read CPU entirely (sections 1.3, 6.3). Nullable:
--              NULL means "no code found" (or a pre-v2 row that was never
--              backfilled -- see migrate-v1-to-v2.sql).
--   All other columns are unchanged from v1, including the 50,000-char
--   parser caps on text_body/html_body (enforced in code, not in SQL).
CREATE TABLE IF NOT EXISTS mails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL,
  sender TEXT,
  subject TEXT,
  text_body TEXT,
  html_body TEXT,
  preview TEXT,
  otp TEXT,
  raw_size INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ----------------------------------------------------------------------------
-- Index: idx_mails_address_id -- the one hot index (section 6.1)
-- ----------------------------------------------------------------------------
-- Every list, delta (since_id), long-poll wait, and cursor-pagination
-- (before_id) query has the same shape:
--     WHERE address = ? [AND id > ? / id < ?] ORDER BY id [DESC]
-- v1's idx_mails_address(address) could find the rows but left SQLite to
-- sort them by id. Keying the index on (address, id DESC) serves both the
-- filter AND the sort from the index alone -- the expected EXPLAIN QUERY
-- PLAN is "SEARCH mails USING INDEX idx_mails_address_id" with no
-- "USE TEMP B-TREE FOR ORDER BY" step.
--
-- Covering-index note (section 6.1): the ideal form of this index also
-- carries the preview columns as included (non-key) columns --
--     ... ON mails(address, id DESC)
--         INCLUDE (sender, subject, preview, otp, created_at)
-- -- which would make the preview query index-only. The INCLUDE clause
-- is not used in the executable statement below because the SQLite
-- builds available in this project's local/CI verification environment
-- reject the INCLUDE syntax outright ("near INCLUDE: syntax error",
-- reproduced on SQLite 3.45 and 3.53 builds), so shipping it would make
-- the schema unverifiable and un-runnable there. The plain composite
-- index below satisfies the normative part of section 6.1 -- filter and
-- sort served from the index, no temp B-tree -- at the cost of a row
-- lookup for sender/subject/preview/otp/created_at, and it never
-- selects text_body/html_body on the list path regardless. If the
-- production D1 build is confirmed to accept INCLUDE, replacing this
-- statement with the INCLUDE form above is a drop-in optimisation with
-- the same index name and the same query plans.
CREATE INDEX IF NOT EXISTS idx_mails_address_id
  ON mails(address, id DESC);

-- ----------------------------------------------------------------------------
-- Index: idx_mails_created_id -- cron expiry scan (section 6.1)
-- ----------------------------------------------------------------------------
-- The hourly scheduled cleanup deletes by age:
--     DELETE ... WHERE created_at < ? (bounded chunks, section 6.3)
-- v1 indexed this with idx_mails_created(created_at). Adding id as the
-- second column keeps rows for the same second in stable id order and
-- lets the cleanup / any "oldest first" scan walk the index directly.
-- This index replaces idx_mails_created; a fresh v2 database simply
-- never creates the old one.
CREATE INDEX IF NOT EXISTS idx_mails_created_id ON mails(created_at, id);

-- ----------------------------------------------------------------------------
-- Indexes on addresses -- kept from v1 (section 6.1)
-- ----------------------------------------------------------------------------
-- idx_addresses_token: the authenticated read path resolves token ->
-- address as a point lookup on every request. Already optimal as a
-- single-column index; v2 keeps it unchanged. (v2 folds auth + list into
-- one JOIN on this lookup -- section 6.2 -- but the index itself needs
-- no change.)
CREATE INDEX IF NOT EXISTS idx_addresses_token ON addresses(token);

-- idx_addresses_address: kept from v1 for compatibility, even though it
-- is technically redundant -- address is declared UNIQUE above, which
-- already creates an automatic unique index. Keeping the named index
-- means a fresh v2 database has exactly the same named indexes a
-- migrated v1 database ends up with, and any tooling that references
-- the name keeps working.
CREATE INDEX IF NOT EXISTS idx_addresses_address ON addresses(address);

-- ----------------------------------------------------------------------------
-- Deliberately NOT created here (they existed in v1):
--   idx_mails_address  -- subsumed by idx_mails_address_id above.
--   idx_mails_created  -- subsumed by idx_mails_created_id above.
-- On a migrated database they are dropped manually/optionally, not by
-- the automatic migration -- see migrate-v1-to-v2.sql for why.
-- ============================================================================
