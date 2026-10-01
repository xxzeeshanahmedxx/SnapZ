-- SnapZ · D1. One row per DAY; the day is the primary key, so re-shooting
-- replaces instead of duplicating. R2 holds the bytes.
CREATE TABLE IF NOT EXISTS snaps (
  day        TEXT PRIMARY KEY,   -- 'YYYY-MM-DD' local date at capture
  ts         INTEGER NOT NULL,   -- epoch ms
  time       TEXT    NOT NULL,   -- 'HH:MM:SS' local
  tz         TEXT,
  lat        REAL,
  lon        REAL,
  accuracy   REAL,
  place      TEXT,
  key        TEXT NOT NULL,      -- R2 key, full image
  url        TEXT NOT NULL,
  thumb_key  TEXT,               -- R2 key, ~320px grid thumbnail
  thumb_url  TEXT,
  mime       TEXT,
  bytes      INTEGER,
  width      INTEGER,
  height     INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snaps_ts ON snaps(ts DESC);

-- Salted hash of your passcode. The passcode itself is never stored.
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
