-- SnapZ · Cloudflare D1 schema
-- One row per DAY. The day is the primary key, so a second photo on the same
-- date replaces the first rather than creating a duplicate.

CREATE TABLE IF NOT EXISTS snaps (
  day        TEXT PRIMARY KEY,      -- 'YYYY-MM-DD' (local date at capture)
  ts         INTEGER NOT NULL,      -- epoch ms, exact capture moment
  time       TEXT    NOT NULL,      -- 'HH:MM:SS' local, human readable
  tz         TEXT,                  -- e.g. 'Asia/Karachi'
  lat        REAL,
  lon        REAL,
  accuracy   REAL,                  -- metres
  place      TEXT,                  -- reverse-geocoded name
  key        TEXT NOT NULL,         -- R2 object key
  url        TEXT NOT NULL,         -- public image URL
  mime       TEXT,
  bytes      INTEGER,
  width      INTEGER,
  height     INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_snaps_ts ON snaps(ts DESC);

-- Key/value config. Holds the salted hash of your passcode, so the passcode
-- itself is never stored anywhere and can be changed from inside the app.
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Passkeys (WebAuthn). Only PUBLIC keys live here; the private key never
-- leaves the phone's secure enclave, and the fingerprint itself never leaves
-- the sensor — the OS only tells the browser "the right finger was presented".
CREATE TABLE IF NOT EXISTS credentials (
  id         TEXT PRIMARY KEY,   -- base64url credential id
  pubkey     TEXT NOT NULL,      -- base64url COSE public key
  alg        INTEGER NOT NULL,   -- -7 = ES256, -257 = RS256
  counter    INTEGER NOT NULL DEFAULT 0,
  name       TEXT,               -- "Zeeshan's iPhone"
  created_at INTEGER NOT NULL,
  last_used  INTEGER
);

-- Short-lived WebAuthn challenges (replay protection).
CREATE TABLE IF NOT EXISTS challenges (
  challenge TEXT PRIMARY KEY,
  expires   INTEGER NOT NULL
);
