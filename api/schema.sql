-- SnapZ · D1. One row per SNAP. Any number per day; `day` is only a label
-- used for grouping in the gallery. R2 holds the bytes.
CREATE TABLE IF NOT EXISTS snaps (
  id         TEXT PRIMARY KEY,   -- '<day>-<ts>-<rand>'
  day        TEXT NOT NULL,      -- 'YYYY-MM-DD' local date at capture
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
CREATE INDEX IF NOT EXISTS idx_snaps_day ON snaps(day);

-- Salted hash of your passcode. The passcode itself is never stored.
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
