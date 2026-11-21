-- Temp Mail D1 Schema
CREATE TABLE IF NOT EXISTS addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT UNIQUE NOT NULL,
  token TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS mails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL,
  sender TEXT,
  subject TEXT,
  text_body TEXT,
  html_body TEXT,
  raw_size INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_mails_address ON mails(address);
CREATE INDEX IF NOT EXISTS idx_mails_created ON mails(created_at);
CREATE INDEX IF NOT EXISTS idx_addresses_token ON addresses(token);
CREATE INDEX IF NOT EXISTS idx_addresses_address ON addresses(address);
